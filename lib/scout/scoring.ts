/**
 * Scoring (section 6). Pure, forward results only: inputs are the logged cards,
 * their paper tracks and the daily bars recorded since.
 */
import { SCOUT } from "@/config/scout";
import { UNIVERSE } from "@/config/universe";
import type { StoredCard, Track } from "./store";
import { type BarsBySymbol, barOn, firstBarAfter, firstBarFrom, signedReturn } from "./tracking";

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface IdeaResult {
  cardId: number;
  origin: "scout" | "human";
  tapped: boolean;
  kind: string;
  status: "promoted" | "late";
  rankScore: number;
  symbol: string;
  direction: "long" | "short";
  entryDate: string;
  exitDate: string | null;
  closed: boolean;
  ret: number;
  spyRet: number | null;
  sectorRet: number | null;
  excess: number | null;
  excessSector: number | null;
  maxDrawdownPct: number | null;
  /** Random same-sector stocks over the same dates, excess vs SPY. */
  baseline: number[];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** One idea's result from its track; open ideas are marked at the latest close. */
export function ideaResult(card: StoredCard, t: Track, bars: BarsBySymbol): IdeaResult | null {
  if (!t.entryDate || !t.entryPrice || card.status === "not_promoted") return null;
  const sym = bars.get(t.symbol) ?? [];
  const closed = !!t.exitDate && t.exitPrice !== null;
  const last = sym[sym.length - 1];
  const exitPx = closed ? t.exitPrice! : last?.c;
  const exitDate = closed ? t.exitDate! : last?.date;
  if (!exitPx || !exitDate || exitDate < t.entryDate) return null;
  const mark = (s: string, entry: number | null) => {
    const b = closed ? barOn(bars.get(s), exitDate)?.o : barOn(bars.get(s), exitDate)?.c;
    return entry && b ? b / entry - 1 : null;
  };
  const ret = signedReturn(t.direction, t.entryPrice, exitPx);
  const spyRet = closed && t.spyExit && t.spyEntry ? t.spyExit / t.spyEntry - 1 : mark("SPY", t.spyEntry);
  const sectorRet = closed && t.sectorExit && t.sectorEntry ? t.sectorExit / t.sectorEntry - 1 : mark(t.sectorEtf, t.sectorEntry);
  const universe = UNIVERSE[card.sector as keyof typeof UNIVERSE] ?? [];
  const rnd = mulberry32(card.id * 7919 + 17);
  const baseline: number[] = [];
  const pool = universe.filter((s) => s !== t.symbol);
  for (let i = 0; i < SCOUT.baselineDraws && pool.length; i++) {
    const s = pool[Math.floor(rnd() * pool.length)];
    const sb = bars.get(s);
    const e = firstBarFrom(sb, t.entryDate);
    const x = closed ? barOn(sb, exitDate) ?? firstBarAfter(sb, exitDate) : barOn(sb, exitDate);
    if (!e || !x || e.date !== t.entryDate || spyRet === null) continue;
    baseline.push(r4(signedReturn(t.direction, e.o, closed ? x.o : x.c) - spyRet));
  }
  return {
    cardId: card.id, origin: card.origin, tapped: !!t.tappedAt, kind: card.kind, status: card.status as "promoted" | "late", rankScore: card.rankScore, symbol: t.symbol, direction: t.direction,
    entryDate: t.entryDate, exitDate: closed ? t.exitDate : null, closed, ret: r4(ret), spyRet: spyRet === null ? null : r4(spyRet), sectorRet: sectorRet === null ? null : r4(sectorRet),
    excess: spyRet === null ? null : r4(ret - spyRet), excessSector: sectorRet === null ? null : r4(ret - sectorRet), maxDrawdownPct: t.maxDrawdownPct, baseline,
  };
}

export interface GroupStats { n: number; closed: number; winRateVsSpy: number | null; avgExcess: number | null; medianExcess: number | null; avgExcessSector: number | null; avgDrawdownPct: number | null }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Stats over closed ideas only (open ideas are shown, not scored). */
export function groupStats(ideas: IdeaResult[]): GroupStats {
  const closed = ideas.filter((i) => i.closed);
  const ex = closed.map((i) => i.excess).filter((x): x is number => x !== null);
  const exS = closed.map((i) => i.excessSector).filter((x): x is number => x !== null);
  const dd = closed.map((i) => i.maxDrawdownPct).filter((x): x is number => x !== null);
  return { n: ideas.length, closed: closed.length, winRateVsSpy: ex.length ? ex.filter((x) => x > 0).length / ex.length : null, avgExcess: mean(ex), medianExcess: median(ex), avgExcessSector: mean(exS), avgDrawdownPct: mean(dd) };
}

export interface Baseline { trials: number; mean: number | null; p5: number | null; p95: number | null; percentileOfActual: number | null }

/**
 * Random-sector baseline: for each closed idea, one of its 20 random same-sector
 * stocks is drawn; the draws' average excess return is one trial. 1,000 trials
 * give a distribution; the result is where the actual average sits in it.
 */
export function baselinePercentile(ideas: IdeaResult[], trials = 1000, seed = 1): Baseline {
  const closed = ideas.filter((i) => i.closed && i.excess !== null && i.baseline.length);
  if (!closed.length) return { trials: 0, mean: null, p5: null, p95: null, percentileOfActual: null };
  const actual = mean(closed.map((i) => i.excess!))!;
  const rnd = mulberry32(seed);
  const avgs: number[] = [];
  for (let t = 0; t < trials; t++) avgs.push(mean(closed.map((i) => i.baseline[Math.floor(rnd() * i.baseline.length)]))!);
  avgs.sort((a, b) => a - b);
  const q = (p: number) => avgs[Math.min(avgs.length - 1, Math.floor(p * avgs.length))];
  return { trials, mean: mean(avgs), p5: q(0.05), p95: q(0.95), percentileOfActual: avgs.filter((a) => a < actual).length / avgs.length };
}

export interface Report {
  byOrigin: Record<"scout" | "human" | "human_tapped", GroupStats>;
  byKind: Record<string, GroupStats>;
  byStatus: Record<"promoted" | "late", GroupStats>;
  byBand: Record<"high" | "low", GroupStats>;
  baseline: Baseline;
  verdict: { due: boolean; closedPromoted: number; months: number; pass: boolean | null; reason: string };
}

export function buildReport(ideas: IdeaResult[], firstCardAt: string | null, now: Date): Report {
  const by = <K extends string>(keys: readonly K[], f: (i: IdeaResult) => K | null) => Object.fromEntries(keys.map((k) => [k, groupStats(ideas.filter((i) => f(i) === k))])) as Record<K, GroupStats>;
  const promoted = ideas.filter((i) => i.status === "promoted");
  const closedPromoted = promoted.filter((i) => i.closed).length;
  const months = firstCardAt ? (now.getTime() - Date.parse(firstCardAt)) / (30.44 * 86400000) : 0;
  const due = closedPromoted >= SCOUT.verdictClosedIdeas && months >= SCOUT.verdictMonths;
  const baseline = baselinePercentile(promoted);
  const avg = groupStats(promoted).avgExcess;
  const pass = due ? (avg ?? -1) > 0 && (baseline.percentileOfActual ?? 0) >= SCOUT.verdictPercentile : null;
  return {
    byOrigin: { scout: groupStats(ideas.filter((i) => i.origin === "scout")), human: groupStats(ideas.filter((i) => i.origin === "human")), human_tapped: groupStats(ideas.filter((i) => i.origin === "human" && i.tapped)) },
    byKind: by(["consumer", "platform", "second_order", "rerating", "event"] as const, (i) => i.kind as never),
    byStatus: by(["promoted", "late"] as const, (i) => i.status),
    byBand: by(["high", "low"] as const, (i) => (i.rankScore >= 49 ? "high" : "low")),
    baseline,
    verdict: {
      due, closedPromoted, months: Math.round(months * 10) / 10, pass,
      reason: due
        ? `average excess ${avg === null ? "n/a" : `${(avg * 100).toFixed(2)}%`}, percentile ${baseline.percentileOfActual === null ? "n/a" : Math.round(baseline.percentileOfActual * 100)} against random same-sector stocks (needs > 0 and ≥ ${SCOUT.verdictPercentile * 100})`
        : `needs ${SCOUT.verdictClosedIdeas} closed promoted ideas (${closedPromoted}) and ${SCOUT.verdictMonths} months (${Math.round(months * 10) / 10}), whichever is later`,
    },
  };
}
