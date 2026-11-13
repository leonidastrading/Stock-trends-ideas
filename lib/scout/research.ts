/**
 * The research step for one candidate: probe the sources, ask the model for a
 * card, measure lateness, apply the gates, and log the card (with model,
 * version and timestamp) before anything else happens.
 */
import type { Kind } from "@/config/scout";
import { SECTORS, type Sector } from "@/config/scout";
import type { MarketData } from "../alpaca";
import { probeAll, type Signal, type Source, type SourceResult } from "../sources";
import { addDays, toEt } from "../time";
import { applyGates, catalystDate, NoEvidenceError, parseCard, rankScore, type Card } from "./card";
import { measureLateness } from "./lateness";
import type { CallModel } from "./llm";
import { buildUserPrompt } from "./prompt";
import * as store from "./store";
import { versionHash, versionSpec } from "./version";

export interface ResearchDeps {
  data: MarketData | null;
  sources: Source[];
  callModel: CallModel;
  now: Date;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface ResearchInput {
  origin: "scout" | "human";
  term: string;
  kindHint: Kind | null;
  tickersHint: string[];
  observation: string | null;
  /** Extra context for the model (a story and the trade the story desk proposed). */
  context?: string;
  trigger?: Signal[];
  /** Results already gathered by the scan for this term (skips re-probing). */
  results?: SourceResult[];
}

export type ResearchOutcome =
  | { outcome: "card"; card: store.StoredCard; candidate: store.Candidate }
  | { outcome: "rejected" | "error" | "capped"; reason: string; candidate: store.Candidate | null };

export async function currentVersion(settings: store.ScoutSettings): Promise<store.Version> {
  const spec = versionSpec(settings.model, settings.effort);
  return store.ensureVersion(versionHash(spec), settings.model, settings.effort, spec);
}

/** Record each source's status on the health panel. */
export async function recordHealth(results: SourceResult[]): Promise<void> {
  for (const r of results) await store.saveHealth(r.source, r.status, r.detail ?? null);
}

export async function researchCandidate(input: ResearchInput, deps: ResearchDeps): Promise<ResearchOutcome> {
  const settings = await store.loadSettings();
  const version = await currentVersion(settings);
  const et = toEt(deps.now);
  const base = { versionId: version.id, origin: input.origin, term: input.term, kindHint: input.kindHint, tickersHint: input.tickersHint, observation: input.observation, trigger: input.trigger ?? null, cardId: null };

  // Spend cap: logged as a rejection so the candidates page shows why nothing happened.
  const spend = await store.spendOn(et.date);
  if (spend.cost >= settings.dailyCapUsd) {
    const reason = `daily LLM cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd}); the scout stopped for ${et.date}`;
    return { outcome: "capped", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
  }

  const results = input.results ?? (await probeAll(deps.sources, { term: input.term, kind: input.kindHint, tickers: input.tickersHint, now: deps.now, env: deps.env, fetchImpl: deps.fetchImpl }));
  if (!input.results) {
    await store.saveSignals(input.term, results.flatMap((r) => r.signals));
    await recordHealth(results);
  }

  const prompt = buildUserPrompt({ origin: input.origin, term: input.term, kindHint: input.kindHint, tickersHint: input.tickersHint, observation: input.observation, context: input.context, today: et.date, results, trigger: input.trigger });

  // Call the model; one retry on a parse/validation failure with the error fed back.
  let card: Card | null = null;
  let replyText = "";
  let modelServed: string | null = null;
  let usage: unknown = null;
  let costUsd = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !card; attempt++) {
    const user = attempt === 0 ? prompt : `${prompt}\n\nA previous reply could not be used (${lastError}). Reply with only the JSON card.`;
    let reply;
    try {
      reply = await deps.callModel({ model: settings.model, effort: settings.effort, user, purpose: "research" });
    } catch (err) {
      const reason = `model call failed: ${err instanceof Error ? err.message : String(err)}`;
      await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "research", usage: null, costUsd: null, ok: false });
      return { outcome: "error", reason, candidate: await store.addCandidate({ ...base, outcome: "error", reason }) };
    }
    await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "research", usage: reply.usage, costUsd: reply.costUsd, ok: true });
    costUsd += reply.costUsd ?? 0;
    replyText = reply.text;
    modelServed = reply.modelServed;
    usage = reply.usage;
    try {
      card = parseCard(reply.text);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!card) {
    const reason = `unusable reply after 2 attempts: ${lastError}`;
    return { outcome: "error", reason, candidate: await store.addCandidate({ ...base, outcome: "error", reason }) };
  }
  card = { ...card, origin: input.origin };

  // Gates, with lateness measured by code for the ticker that will be tracked.
  const measured = await measureLateness(deps.data, card.tickers[0].symbol, deps.now);
  let gated;
  try {
    gated = applyGates(card, measured, { wholeCompany: !!input.context });
  } catch (err) {
    if (!(err instanceof NoEvidenceError)) throw err;
    return { outcome: "rejected", reason: err.message, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason: err.message }) };
  }

  // Log the card before anything else happens.
  const cDate = catalystDate(gated.card);
  const stored = await store.insertCard({
    versionId: version.id, origin: input.origin, card: gated.card, model: settings.model, modelServed, prompt, replyText, usage, costUsd: costUsd || null,
    status: gated.status, gateNotes: gated.notes, catalystDate: cDate, rankScore: rankScore(gated.card),
  });
  const candidate = await store.addCandidate({ ...base, outcome: "card", reason: gated.status, cardId: stored.id });

  // Paper track for promoted and late cards: entry at the next open, exit at the earlier of catalyst + 1 day and the time limit.
  if (gated.status !== "not_promoted") {
    const byLimit = addDays(et.date, gated.card.time_limit_days);
    const byCatalyst = cDate && cDate >= et.date ? addDays(cDate, 1) : null;
    const deadline = byCatalyst && byCatalyst < byLimit ? byCatalyst : byLimit;
    await store.insertTrack({ cardId: stored.id, symbol: stored.primaryTicker, sectorEtf: SECTORS[stored.sector as Sector], direction: stored.direction, cardDate: et.date, deadlineDate: deadline });
  }

  // What Vadim noticed stays on the watch-list as a proposal he can approve.
  if (input.origin === "human") {
    await store.addWatch({ term: gated.card.title, kind: gated.card.kind, tickers: gated.card.tickers.map((t) => t.symbol), addedBy: "scout", status: "proposed", note: `from human-originated card #${stored.id}` });
  }
  return { outcome: "card", card: stored, candidate };
}
