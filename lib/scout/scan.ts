/**
 * The daily scan: measure every active watch-list term on every source, keep
 * the measurements as history, flag the terms that accelerate, and research
 * the strongest few. Pure helpers are exported for tests.
 */
import { SCOUT, type Kind } from "@/config/scout";
import { probeAll, type Signal, type SourceResult } from "../sources";
import { buildTriagePrompt, gatherPulse, parseTriage, triggerFor } from "./discovery";
import { trendingNow } from "../sources/googletrends";
import { toEt } from "../time";
import { recordHealth, researchCandidate, type ResearchDeps, type ResearchOutcome } from "./research";
import * as store from "./store";

/** Metrics where a lower value is the stronger signal (chart rank). */
const LOWER_IS_BETTER = new Set(["app_store:top_free_rank", "stocktwits:trending_rank"]);
const lowerIsBetter = (s: Signal) => LOWER_IS_BETTER.has(`${s.source}:${s.metric.split(":")[0]}`);
/** Needs this many stored days before the scout's own history is used as the 12-month base. */
const MIN_HISTORY_DAYS = 30;

/** Pure: fill in a 12-month base from stored history where the source gave none. */
export function withHistory(signals: Signal[], history: Record<string, { avg: number; n: number }>): Signal[] {
  return signals.map((s) => {
    if (s.baseline !== null && s.changeVs12m !== null) return s;
    const h = history[`${s.source}:${s.metric}`];
    if (!h || h.n < MIN_HISTORY_DAYS || h.avg <= 0) return s;
    const lower = lowerIsBetter(s);
    const change = lower ? (s.value > 0 ? h.avg / s.value - 1 : null) : s.value / h.avg - 1;
    return { ...s, baseline: Math.round(h.avg * 10) / 10, changeVs12m: change, note: `${s.note}; 12-month base from ${h.n} stored days: ${Math.round(h.avg * 10) / 10}` };
  });
}

export interface Acceleration {
  /** Signals above the acceleration threshold, one per source at most. */
  accelerating: Signal[];
  /** Sum of the changes, for ranking candidates. */
  score: number;
  /** Event terms: the largest weekly odds move seen, in points. */
  oddsMove: number;
  isCandidate: boolean;
}

/** Pure: the candidate rule. At least N sources accelerating by X, or an event's odds moving by Y points. */
export function acceleration(signals: Signal[], kind: string | null): Acceleration {
  const bySource = new Map<string, Signal>();
  for (const s of signals) {
    if (s.changeVs12m === null || s.changeVs12m < SCOUT.minChangeVs12m) continue;
    const prev = bySource.get(s.source);
    if (!prev || (s.changeVs12m ?? 0) > (prev.changeVs12m ?? 0)) bySource.set(s.source, s);
  }
  const accelerating = [...bySource.values()];
  const single = accelerating.some((s) => (s.changeVs12m ?? 0) >= SCOUT.minSingleSourceChange);
  const oddsMove = Math.max(0, ...signals.filter((s) => s.source === "polymarket").map((s) => Math.abs(Number((s.detail as { week_change_points?: number } | undefined)?.week_change_points ?? 0))));
  const eventTrigger = kind === "event" && oddsMove >= SCOUT.minOddsMovePoints;
  return {
    accelerating: eventTrigger ? [...accelerating, ...signals.filter((s) => s.source === "polymarket" && !bySource.has("polymarket")).slice(0, 1)] : accelerating,
    score: accelerating.reduce((a, s) => a + (s.changeVs12m ?? 0), 0) + (eventTrigger ? oddsMove / 10 : 0),
    oddsMove,
    isCandidate: accelerating.length >= SCOUT.minAcceleratingSources || single || eventTrigger,
  };
}

export interface ScanReport {
  date: string;
  terms: number;
  measured: Array<{ term: string; kind: string; sources: number; accelerating: number; score: number; candidate: boolean; cooldown: boolean }>;
  researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>;
  risingQueries: Array<{ title: string; traffic: string }>;
  discovery: { headlinesRead: number; read: string | null; proposed: Array<{ term: string; kind: string; tickers: string[]; why: string }>; problems: string[]; error: string | null } | null;
  stoppedEarly: string | null;
}

export async function runScan(deps: ResearchDeps): Promise<ScanReport> {
  const et = toEt(deps.now);
  await store.seedWatchlist();
  const settings = await store.loadSettings();
  const items = await store.watchlist("active");
  const cooldown = await store.recentTerms(SCOUT.candidateCooldownDays);
  const report: ScanReport = { date: et.date, terms: items.length, measured: [], researched: [], risingQueries: [], discovery: null, stoppedEarly: null };

  // Health is the worst status each source showed today, "ok" winning over "no data".
  const health = new Map<string, SourceResult>();
  const rank = { ok: 0, capped: 1, down: 2, missing: 3 };
  const candidates: Array<{ term: string; kind: string; tickers: string[]; results: SourceResult[]; acc: Acceleration }> = [];

  for (const w of items) {
    // A source measured for this term today is not called again (quotas, rate limits); its stored signals are reused.
    const today = await store.signalsOn(w.term, et.date);
    const fresh = deps.sources.filter((s) => !today.has(s.id));
    const results: SourceResult[] = [
      ...(await probeAll(fresh, { term: w.term, kind: w.kind, tickers: w.tickers, now: deps.now, env: deps.env, fetchImpl: deps.fetchImpl })),
      ...deps.sources.filter((s) => today.has(s.id)).map((s): SourceResult => ({ source: s.id, status: "ok", detail: "measured earlier today; reused", signals: today.get(s.id)! })),
    ];
    for (const r of results) {
      const prev = health.get(r.source);
      if (!prev || rank[r.status] > rank[prev.status]) health.set(r.source, r);
    }
    const history = await store.signalHistory(w.term, et.date);
    const signals = withHistory(results.flatMap((r) => r.signals), history);
    await store.saveSignals(w.term, signals, et.date);
    const acc = acceleration(signals, w.kind);
    const cool = cooldown.has(w.term.toLowerCase());
    report.measured.push({ term: w.term, kind: w.kind, sources: results.filter((r) => r.signals.length).length, accelerating: acc.accelerating.length, score: Math.round(acc.score * 100) / 100, candidate: acc.isCandidate, cooldown: cool });
    if (acc.isCandidate && !cool) candidates.push({ term: w.term, kind: w.kind, tickers: w.tickers, results: results.map((r) => ({ ...r, signals: signals.filter((s) => s.source === r.source) })), acc });
  }
  await recordHealth([...health.values()]);

  try {
    report.risingQueries = (await trendingNow(deps.fetchImpl)).slice(0, 20);
  } catch (err) {
    report.risingQueries = [];
    await store.saveHealth("google_trends_rising", "down", err instanceof Error ? err.message.slice(0, 200) : String(err));
  }

  if (!settings.enabled) {
    report.stoppedEarly = "scout is switched off in Settings; measurements kept, nothing researched";
    return report;
  }
  candidates.sort((a, b) => b.acc.score - a.acc.score);
  for (const c of candidates.slice(0, settings.maxCandidatesPerScan)) {
    const r: ResearchOutcome = await researchCandidate({ origin: "scout", term: c.term, kindHint: c.kind as never, tickersHint: c.tickers, observation: null, trigger: c.acc.accelerating, results: c.results }, deps);
    report.researched.push(r.outcome === "card" ? { term: c.term, outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term: c.term, outcome: r.outcome, reason: r.reason });
    if (r.outcome === "capped") {
      report.stoppedEarly = r.reason;
      return report;
    }
  }

  // Discovery: read the day's news and trending lists, let the model propose what the watch-list would miss.
  if (settings.discoveryPerScan > 0) report.discovery = await runDiscovery(deps, settings.discoveryPerScan, cooldown, report);
  return report;
}

async function runDiscovery(deps: ResearchDeps, max: number, cooldown: Set<string>, report: ScanReport): Promise<NonNullable<ScanReport["discovery"]>> {
  const et = toEt(deps.now);
  const out: NonNullable<ScanReport["discovery"]> = { headlinesRead: 0, read: null, proposed: [], problems: [], error: null };
  const settings = await store.loadSettings();
  const spend = await store.spendOn(et.date);
  if (spend.cost >= settings.dailyCapUsd) {
    out.error = `daily LLM cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd})`;
    return out;
  }
  const pulse = await gatherPulse(deps.data, deps.now, deps.fetchImpl);
  out.headlinesRead = pulse.headlinesRead;
  out.problems = pulse.problems;
  const avoid = [...cooldown, ...report.researched.map((r) => r.term.toLowerCase())];
  const prompt = buildTriagePrompt(pulse, max, avoid);
  let triage;
  try {
    const reply = await deps.callModel({ model: settings.model, effort: "medium", user: prompt, purpose: "triage" });
    await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "triage", usage: reply.usage, costUsd: reply.costUsd, ok: true });
    triage = parseTriage(reply.text);
  } catch (err) {
    await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "triage", usage: null, costUsd: null, ok: false });
    out.error = `triage failed: ${err instanceof Error ? err.message : String(err)}`;
    return out;
  }
  out.read = triage.read;
  for (const c of triage.candidates.slice(0, max)) {
    out.proposed.push({ term: c.term, kind: c.kind, tickers: c.tickers, why: c.why });
    if (avoid.includes(c.term.toLowerCase())) continue;
    const r = await researchCandidate({ origin: "scout", term: c.term, kindHint: c.kind as Kind, tickersHint: c.tickers, observation: null, trigger: triggerFor(c, et.date) }, deps);
    report.researched.push(r.outcome === "card" ? { term: c.term, outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term: c.term, outcome: r.outcome, reason: r.reason });
    if (r.outcome === "card" && r.card.status !== "not_promoted") {
      await store.addWatch({ term: c.term, kind: c.kind, tickers: c.tickers, addedBy: "scout", status: "proposed", note: `discovered ${et.date}: ${c.why.slice(0, 200)}` });
    }
    if (r.outcome === "capped") {
      report.stoppedEarly = r.reason;
      break;
    }
  }
  return out;
}
