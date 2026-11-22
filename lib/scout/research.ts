/**
 * The research step for one candidate: probe the sources, ask the model for a
 * card, measure lateness, apply the gates, and log the card (with model,
 * version and timestamp) before anything else happens.
 */
import type { Kind } from "@/config/scout";
import { SCOUT, SECTORS, type Sector } from "@/config/scout";
import type { MarketData } from "../alpaca";
import { probeAll, type Signal, type Source, type SourceResult } from "../sources";
import { addDays, toEt } from "../time";
import { applyGates, catalystDate, NoEvidenceError, parseCard, rankScore, type Card } from "./card";
import { measureLateness } from "./lateness";
import type { CallModel } from "./llm";
import { buildUserPrompt } from "./prompt";
import * as store from "./store";
import { versionHash, versionSpec } from "./version";

/** The Anthropic API account has no credit left (every AI call fails until it is topped up). */
export const CREDIT_OUT = /credit balance is too low|insufficient[_ ]credit|billing/i;

/** One phone alert a day while the API credit is empty. */
export async function alertCreditOut(env: NodeJS.ProcessEnv, etDate: string): Promise<void> {
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured(env) || !(await store.claimNotification(`credit-out:${etDate}`, "Anthropic API credit empty"))) return;
  await sendPush({ title: "Trend scout: Anthropic API credit is empty", message: "Every AI call is failing (research, investigations, Dots…). Ideas wait in the catch-up queue. Add credit at console.anthropic.com → Plans & Billing (this is separate from your Claude Max plan).", tags: ["warning"], priority: 4, click: "https://console.anthropic.com/settings/billing" }, env);
}

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
  /** The page the idea was sent from, with a link back ("Dots", "/dots?run=12#dot-121"). */
  source?: { label: string; url?: string | null };
  trigger?: Signal[];
  /** Results already gathered by the scan for this term (skips re-probing). */
  results?: SourceResult[];
  /** The direction the desk proposes, when it proposes one: a short under $5 is skipped before any AI call. */
  proposedDirection?: "long" | "short";
  /** Run from the catch-up queue (not queued again when the cap turns it away). */
  queued?: boolean;
}

/** The latest price of a stock (snapshot, else the last daily close), or null. */
async function lastPrice(data: ResearchDeps["data"], symbol: string | undefined, today: string): Promise<number | null> {
  if (!data || !symbol) return null;
  const snap = await data.getSnapshots?.([symbol]).catch(() => null);
  if (snap?.[symbol]?.price) return snap[symbol].price;
  const bars = await data.getDailyBars([symbol], addDays(today, -10), today).catch(() => []);
  return bars.filter((b) => b.symbol === symbol).sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.c ?? null;
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
  const base = { versionId: version.id, origin: input.origin, term: input.term, kindHint: input.kindHint, tickersHint: input.tickersHint, observation: input.observation, trigger: input.trigger ?? null, cardId: null, sourceLabel: input.source?.label ?? null, sourceUrl: input.source?.url ?? null };

  // Spend cap: logged as a rejection so the candidates page shows why nothing happened.
  const spend = await store.spendOn(et.date);
  if (spend.cost >= settings.dailyCapUsd) {
    const reason = `waiting: daily LLM cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd}); queued, researched after the midnight ET reset`;
    // Nothing is skipped: the idea goes on the catch-up queue and is researched once the budget resets.
    if (!input.queued) await import("./catchup").then(({ enqueue, queuedResearch }) => enqueue("research", `${input.origin}:${input.term.toLowerCase()}:${input.tickersHint.join(",")}`, queuedResearch(input))).catch((err) => console.error(`queue failed: ${err instanceof Error ? err.message : String(err)}`));
    return { outcome: "capped", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
  }

  // One card per stock and direction per player (14 days): skip a repeat before spending anything on it.
  const { DUPLICATE_DAYS, duplicateOf, existingCalls } = await import("./dedupe");
  const recentCalls = async () => existingCalls(...(await Promise.all([store.cardsSince(DUPLICATE_DAYS), store.candidatesSince(DUPLICATE_DAYS), store.allTracks()])));
  const early = duplicateOf(await recentCalls(), { origin: input.origin, term: input.term, symbol: input.tickersHint[0] });
  if (early) {
    const reason = `duplicate: card #${early.cardId} (${early.createdAt.slice(0, 10)}) already calls ${early.direction} ${early.symbol} for the same player`;
    return { outcome: "rejected", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
  }

  // No shorts under $5 (hard to borrow, squeeze-prone): a proposed one is skipped before anything is spent on it.
  if (input.proposedDirection === "short") {
    const px = await lastPrice(deps.data, input.tickersHint[0], et.date);
    if (px !== null && px < SCOUT.minShortPrice) {
      const reason = `short under $${SCOUT.minShortPrice}: ${input.tickersHint[0]} at $${px.toFixed(2)} (no shorts under $${SCOUT.minShortPrice})`;
      return { outcome: "rejected", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
    }
  }

  const results = input.results ?? (await probeAll(deps.sources, { term: input.term, kind: input.kindHint, tickers: input.tickersHint, now: deps.now, env: deps.env, fetchImpl: deps.fetchImpl }));
  if (!input.results) {
    await store.saveSignals(input.term, results.flatMap((r) => r.signals));
    await recordHealth(results);
  }

  const [optionsLine, positioning, known, backdrop, calls] = await Promise.all([
    readOptions(deps, input.tickersHint[0]),
    input.tickersHint[0] ? import("../market/positioning").then(({ positioningFor }) => positioningFor(input.tickersHint[0], deps.now, deps.fetchImpl)).catch(() => null) : Promise.resolve(null),
    // Investigations, earlier cards, themes, Dots, rumors, lawsuits, FDA dates, filings, insiders, Congress: background.
    input.tickersHint.length ? import("./known").then(({ whatTheScoutKnows }) => whatTheScoutKnows(input.tickersHint, deps.now)).catch(() => null) : Promise.resolve(null),
    // The bigger picture: what the AI trade as a whole is doing (AI-linked names move with the theme).
    import("./backdrop").then(async ({ aiBackdrop, backdropText }) => { const b = await aiBackdrop(deps.data, deps.now); return b ? backdropText(b) : null; }).catch(() => null),
    // Open paper calls, so a related ticker never contradicts one.
    store.allTracks().then(async (t) => (await import("./conflicts")).openCalls(t)).catch(() => []),
  ]);
  // Name the page an idea was sent from, so the card credits it ("the scout's Dots tab found…"), not "Vadim reports".
  const sourceNote = input.source && input.source.label !== "Your note" ? `Where this idea came from: the ${input.source.label} tab of this scout${input.source.url ? ` (${input.source.url})` : ""}, sent to research by Vadim. Credit it to that page when you describe where the idea came from; the facts in it are what that page read. ` : "";
  const prompt = buildUserPrompt({ origin: input.origin, term: input.term, kindHint: input.kindHint, tickersHint: input.tickersHint, observation: input.observation ? `${sourceNote}${input.observation}` : input.observation, context: input.context, today: et.date, results, trigger: input.trigger })
    + (optionsLine ? `\n\nOptions pricing (for the "expression" note only; not evidence): ${optionsLine}` : "")
    + (positioning ? `\n\nPositioning (who is already in the trade; say whether the call goes with or against it, and treat a crowded side as a risk, not proof): ${positioning.text}` : "")
    + (known ? `\n\n${known}\nUse it to build a complete picture: say in the thesis or risks when it supports, contradicts or changes the call (an earlier card on the same stock that failed, an investigation's confirmed findings, a lawsuit, an FDA date), and never cite it as if it were news or a source.` : "")
    + (backdrop ? `\n\n${backdrop}` : "")
    + (await import("./conflicts").then(({ openCallsText }) => { const t = openCallsText(calls); return t ? `\n\n${t}` : ""; }));

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
      const msg = err instanceof Error ? err.message : String(err);
      await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "research", usage: null, costUsd: null, ok: false });
      // The Anthropic API account is out of credit: nothing is lost, the idea waits in the catch-up queue like an over-budget one.
      if (CREDIT_OUT.test(msg)) {
        const reason = "waiting: daily AI cap reached in effect (the Anthropic API credit balance is empty; add credit at console.anthropic.com → Plans & Billing); queued, researched once there is credit";
        if (!input.queued) await import("./catchup").then(({ enqueue, queuedResearch }) => enqueue("research", `${input.origin}:${input.term.toLowerCase()}:${input.tickersHint.join(",")}`, queuedResearch(input))).catch(() => undefined);
        await alertCreditOut(deps.env, et.date).catch(() => undefined);
        return { outcome: "capped", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
      }
      const reason = `model call failed: ${msg}`;
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

  // Each ticker must still mean the company named (symbols get reused: SATS was EchoStar, now a Strive preferred).
  const identity = await verifyTickers(card, deps);
  card = identity.card;
  // A related ticker that an open call points the other way on is left out (the card would recommend both sides).
  const conflicts = (await import("./conflicts")).dropContradictions(card, calls);
  card = conflicts.card;
  identity.notes.push(...conflicts.notes);

  // Gates, with lateness measured by code for the ticker that will be tracked.
  const measured = await measureLateness(deps.data, card.tickers[0].symbol, deps.now);
  let gated;
  try {
    gated = applyGates(card, measured, { wholeCompany: !!input.context });
  } catch (err) {
    if (!(err instanceof NoEvidenceError)) throw err;
    // In plain words: what was missing, and for an idea typed in, what to try instead.
    const reason = `no evidence: the scout's sources (news, search interest, filings, prices) found no dated facts that back this up, so no card${input.origin === "human" ? ". The text you give is a lead, not evidence: name a US-listed ticker and a short term to search for (e.g. \"neuromorphic chips\"), or paste an article that has the facts and dates" : ""}.`;
    return { outcome: "rejected", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
  }
  if (identity.notes.length) gated = { ...gated, notes: [...identity.notes, ...gated.notes] };
  if (identity.noValidTicker) gated = { ...gated, status: "not_promoted" as const, notes: [...gated.notes, "not promoted: no ticker that is still the named company's stock"] };

  // The model may have chosen a different stock than the hint, or a parallel import may have just logged the same call.
  const late = duplicateOf(await recentCalls(), { origin: input.origin, term: input.term, symbol: gated.card.tickers[0].symbol, direction: gated.card.direction });
  if (late) {
    const reason = `duplicate: card #${late.cardId} (${late.createdAt.slice(0, 10)}) already calls ${late.direction} ${late.symbol} for the same player`;
    return { outcome: "rejected", reason, candidate: await store.addCandidate({ ...base, outcome: "rejected", reason }) };
  }

  // Log the card before anything else happens.
  const cDate = catalystDate(gated.card);
  const stored = await store.insertCard({
    versionId: version.id, origin: input.origin, card: gated.card, model: settings.model, modelServed, prompt, replyText, usage, costUsd: costUsd || null,
    status: gated.status, gateNotes: gated.notes, catalystDate: cDate, rankScore: rankScore(gated.card),
  });
  const candidate = await store.addCandidate({ ...base, outcome: "card", reason: gated.status, cardId: stored.id });
  // How crowded the stock is as the card is written (attention, news, searches, extension): recorded once, never back-filled.
  await import("./crowding").then(({ recordEntryCrowding }) => recordEntryCrowding(stored.id, stored.primaryTicker, deps.data, deps.now, deps.fetchImpl)).catch(() => undefined);
  // The name each symbol trades as and its next earnings, for the card's header.
  await import("./symbols").then(({ refreshSymbolInfo }) => refreshSymbolInfo(deps.data, deps.env, gated.card.tickers.map((t) => t.symbol), deps.now, 20, deps.fetchImpl)).catch(() => undefined);

  // Paper track for promoted and late cards: entry at the next open, exit at the card's time limit (or earlier when its
  // invalidation is marked). The catalyst date no longer ends the trade (it did before EXIT_RULE "time_limit"): a card
  // whose catalyst fell on its entry day was closed after one night, against the time it said it needed.
  if (gated.status !== "not_promoted") {
    const deadline = addDays(et.date, gated.card.time_limit_days);
    await store.insertTrack({ cardId: stored.id, symbol: stored.primaryTicker, sectorEtf: SECTORS[stored.sector as Sector], direction: stored.direction, cardDate: et.date, deadlineDate: deadline });
  }

  // What Vadim noticed stays on the watch-list as a proposal he can approve.
  if (input.origin === "human") {
    await store.addWatch({ term: gated.card.title, kind: gated.card.kind, tickers: gated.card.tickers.map((t) => t.symbol), addedBy: "scout", status: settings.autoApproveTerms === false ? "proposed" : "active", note: `from human-originated card #${stored.id}` });
  }
  return { outcome: "card", card: stored, candidate };
}

/** The options read for the primary ticker, recorded in source health; never fails the research. */
async function readOptions(deps: ResearchDeps, ticker: string | undefined): Promise<string | null> {
  if (!ticker || !deps.data?.getOptionSnapshots) return null;
  try {
    const { optionsRead } = await import("./options");
    const o = await optionsRead(deps.data, ticker, deps.now);
    await store.saveHealth("options", "ok", o ? o.line.slice(0, 300) : `${ticker}: no near-the-money contracts 20-60 days out`);
    return o?.line ?? null;
  } catch (err) {
    await store.saveHealth("options", "down", `${ticker}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`).catch(() => undefined);
    return null;
  }
}

/** Check every ticker against what it trades as now; correct, drop or flag. Skipped when asset lookups are unavailable. */
export async function verifyTickers(card: Card, deps: ResearchDeps): Promise<{ card: Card; notes: string[]; noValidTicker: boolean }> {
  const data = deps.data;
  if (!data?.getAsset) return { card, notes: [], noValidTicker: false };
  const { checkTicker, notCommon } = await import("./identity");
  const ua = deps.env.SEC_USER_AGENT?.trim();
  const sec = ua ? await import("../sources/edgar").then(({ secTickerList }) => secTickerList(ua, deps.fetchImpl)).catch(() => null) : null;
  const notes: string[] = [];
  const kept: Card["tickers"] = [];
  for (const t of card.tickers) {
    let asset;
    try {
      asset = await data.getAsset(t.symbol);
    } catch {
      kept.push(t); // lookup failed: keep, the price checks still apply
      continue;
    }
    const c = checkTicker(t.symbol, t.company ?? null, asset, sec);
    if (c.action === "corrected" && c.to) {
      const a = await data.getAsset(c.to).catch(() => null);
      if (a && a.tradable && !notCommon(a.name)) {
        if (!kept.some((k) => k.symbol === c.to)) kept.push({ ...t, symbol: c.to });
        notes.push(c.note!);
        continue;
      }
      notes.push(`${t.symbol}: ${asset?.name ? `now trades as "${asset.name}"` : "not listed"}; the company's symbol ${c.to} could not be confirmed either; dropped`);
      continue;
    }
    if (c.action === "dropped") {
      notes.push(c.note!);
      continue;
    }
    if (c.action === "unconfirmed") notes.push(c.note!);
    kept.push(t);
  }
  if (!kept.length) return { card, notes, noValidTicker: true };
  return { card: { ...card, tickers: kept }, notes, noValidTicker: false };
}
