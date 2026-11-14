/**
 * The chatter test. Research on news says prices under-react at first and
 * catch up as a story spreads; research on message boards says chatter
 * predicts volatility more reliably than direction. This tests it on our own
 * data, forward only:
 *
 * - Each weekday every symbol in the fixed 198-stock universe is measured once
 *   from Stocktwits' public stream (messages per hour over the latest 30, the
 *   bullish share of tagged messages), in fixed batches.
 * - A spike is today's log rate >= 2.5 standard deviations above the symbol's
 *   own trailing measurements (at least 20, up to 60), the first in 5 days.
 *   About 1 in 40 ordinary symbol-days, picked by a hash of date and symbol,
 *   is logged as a control. Both are written the day they are measured.
 * - Outcomes come from daily bars afterwards: entry at the next open, the
 *   excess over SPY and the sector fund 1, 5 and 20 sessions later. A spike is
 *   "quiet" when the 5 sessions before it moved less than 3% against SPY:
 *   chatter leading the price, not following it.
 *
 * An experiment beside the scout: nothing here becomes card evidence.
 */
import { CHATTER, CHATTER_UNIVERSE } from "@/config/chatter";
import type { DailyBar, MarketData } from "../alpaca";
import { getJson } from "../http";
import { messageRate, ST_HOST, ST_UA, type StMessage, type StTrending, trendingEntry } from "../sources/stocktwits";
import { fetchEarningsDates } from "../sources/edgar";
import { addDays, daysBetween, toEt } from "../time";
import * as store from "./store";

// ------------------------------------------------------------------ pure

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Pure: z-score of today's value against trailing values (log scale for rates). Null with too little history. */
export function spikeScore(history: number[], today: number, opts: { log?: boolean; minHistory?: number; lookback?: number } = {}): { z: number; baseline: number } | null {
  const { log = true, minHistory = CHATTER.minHistory, lookback = CHATTER.lookbackDays } = opts;
  const f = (x: number) => (log ? Math.log(x + 0.1) : x);
  const h = history.slice(-lookback).map(f);
  if (h.length < minHistory) return null;
  const m = mean(h);
  const sd = Math.max(Math.sqrt(h.reduce((a, b) => a + (b - m) ** 2, 0) / (h.length - 1)), log ? 0.15 : 2);
  return { z: (f(today) - m) / sd, baseline: log ? Math.exp(m) - 0.1 : m };
}

/** Pure, deterministic: is this ordinary symbol-day a control? (FNV-1a hash of "date|symbol".) */
export function isControlDay(date: string, symbol: string, oneIn = CHATTER.controlOneIn): boolean {
  let h = 0x811c9dc5;
  for (const ch of `${date}|${symbol}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h % oneIn === 0;
}

export interface Outcome { entryDate: string; prior5Excess: number | null; quiet: boolean | null; excess: Record<number, number | null>; excessSector: Record<number, number | null> }

/** Pure: entry at the first open after `date`; excess over SPY / sector after N sessions (close); prior 5-session excess up to the close before `date`. */
export function eventOutcome(date: string, sym: DailyBar[], spy: DailyBar[], etf: DailyBar[], horizons: readonly number[] = CHATTER.horizons): Outcome | null {
  const s = sym.slice().sort((a, b) => a.date.localeCompare(b.date));
  const i = s.findIndex((b) => b.date > date);
  if (i < 0) return null;
  const spyBy = new Map(spy.map((b) => [b.date, b]));
  const etfBy = new Map(etf.map((b) => [b.date, b]));
  const entry = s[i];
  // Benchmarks over the same dates: open on the entry day to close on the exit day.
  const bench = (m: Map<string, DailyBar>, exitDate: string) => {
    const a = m.get(entry.date), b = m.get(exitDate);
    return a && b ? b.c / a.o - 1 : null;
  };
  const excess: Record<number, number | null> = {}, excessSector: Record<number, number | null> = {};
  for (const n of horizons) {
    const j = i + n - 1;
    if (j >= s.length) {
      excess[n] = null;
      excessSector[n] = null;
      continue;
    }
    const r = s[j].c / entry.o - 1;
    const rs = bench(spyBy, s[j].date), re = bench(etfBy, s[j].date);
    excess[n] = rs === null ? null : r - rs;
    excessSector[n] = re === null ? null : r - re;
  }
  // Prior: the 5 sessions ending with the close before the event date.
  let prior5Excess: number | null = null;
  const before = s.filter((b) => b.date < date);
  if (before.length >= 6) {
    const c0 = before[before.length - 1], c5 = before[before.length - 6];
    const sp0 = spyBy.get(c0.date), sp5 = spyBy.get(c5.date);
    if (sp0 && sp5) prior5Excess = c0.c / c5.c - 1 - (sp0.c / sp5.c - 1);
  }
  return { entryDate: entry.date, prior5Excess, quiet: prior5Excess === null ? null : Math.abs(prior5Excess) * 100 < CHATTER.quietPct, excess, excessSector };
}

export type Group = "quiet_bullish" | "quiet_bearish" | "quiet_mixed" | "after_move" | "earnings" | "control";
export const GROUP_LABEL: Record<Group, string> = {
  earnings: "Spike within 3 days of an earnings release (a known event, read apart)",
  quiet_bullish: "Spike, quiet price, bullish chatter",
  quiet_bearish: "Spike, quiet price, bearish chatter",
  quiet_mixed: "Spike, quiet price, mixed or untagged",
  after_move: "Spike after a 3%+ move (chatter following price)",
  control: "Control: ordinary days, random",
};

/** Pure: an earnings release (8-K item 2.02) within 3 calendar days either side. */
export function nearEarnings(date: string, earnings: string[] | undefined, days = 3): boolean {
  return !!earnings?.some((d) => Math.abs(daysBetween(d, date)) <= days);
}

export function groupOf(kind: "spike" | "control", bullishShare: number | null, quiet: boolean | null, earnings = false): Group | null {
  if (kind === "control") return "control";
  if (earnings) return "earnings";
  if (quiet === null) return null;
  if (!quiet) return "after_move";
  if (bullishShare !== null && bullishShare >= CHATTER.bullishShare) return "quiet_bullish";
  if (bullishShare !== null && bullishShare <= CHATTER.bearishShare) return "quiet_bearish";
  return "quiet_mixed";
}

export interface GroupStat { n: number; mean: number | null; median: number | null; hit: number | null; meanAbs: number | null }

export function stat(xs: Array<number | null>): GroupStat {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, median: null, hit: null, meanAbs: null };
  const sorted = v.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { n: v.length, mean: mean(v), median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, hit: v.filter((x) => x > 0).length / v.length, meanAbs: mean(v.map(Math.abs)) };
}

export interface ChatterReportRow { group: Group; events: number; byHorizon: Record<number, GroupStat>; byHorizonSector: Record<number, GroupStat> }

/** Pure: group events with outcomes into the report table. */
export function chatterReport(events: Array<{ kind: "spike" | "control"; bullishShare: number | null; outcome: Outcome | null; nearEarnings?: boolean }>): ChatterReportRow[] {
  const groups: Group[] = ["quiet_bullish", "quiet_bearish", "quiet_mixed", "after_move", "earnings", "control"];
  return groups.map((g) => {
    const mine = events.filter((e) => e.outcome && groupOf(e.kind, e.bullishShare, e.outcome.quiet, e.nearEarnings) === g);
    const byHorizon: Record<number, GroupStat> = {}, byHorizonSector: Record<number, GroupStat> = {};
    for (const n of CHATTER.horizons) {
      byHorizon[n] = stat(mine.map((e) => e.outcome!.excess[n]));
      byHorizonSector[n] = stat(mine.map((e) => e.outcome!.excessSector[n]));
    }
    return { group: g, events: mine.length, byHorizon, byHorizonSector };
  });
}

// ------------------------------------------------------------- measuring

interface Stream { symbol?: { watchlist_count?: number }; messages?: StMessage[] }

export interface ChatterBatchReport { date: string; measured: number; spikes: string[]; controls: number; remaining: number; skipped: string | null; errors: string[] }

/** Measure the next batch of symbols not yet measured today (weekdays only). Safe to call often. */
export async function runChatterBatch(now: Date, fetchImpl?: typeof fetch, batch = CHATTER.batch): Promise<ChatterBatchReport> {
  const et = toEt(now);
  const report: ChatterBatchReport = { date: et.date, measured: 0, spikes: [], controls: 0, remaining: 0, skipped: null, errors: [] };
  const dow = new Date(`${et.date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return { ...report, skipped: "weekend" };
  const done = await store.chatterMeasuredOn(et.date);
  const todo = CHATTER_UNIVERSE.filter((u) => !done.has(u.symbol));
  report.remaining = todo.length;
  if (!todo.length) return report;
  const trending = await getJson<{ symbols?: StTrending[] }>(`${ST_HOST}/trending/symbols/equities.json`, { headers: ST_UA, minIntervalMs: 1500, fetchImpl, cacheMs: 30 * 60000 }).then((r) => r.symbols ?? []).catch(() => [] as StTrending[]);
  for (const u of todo.slice(0, batch)) {
    let stream: Stream;
    try {
      stream = await getJson<Stream>(`${ST_HOST}/streams/symbol/${encodeURIComponent(u.symbol)}.json?limit=30`, { headers: ST_UA, minIntervalMs: 1500, fetchImpl, cacheMs: 0, retries: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${u.symbol}: ${msg.slice(0, 120)}`);
      if (/ 429/.test(msg)) break; // rate-limited: the next call picks up here
      continue;
    }
    const msgs = stream.messages ?? [];
    const rate = messageRate(msgs, now);
    if (!rate) {
      report.errors.push(`${u.symbol}: fewer than 2 messages`);
      continue;
    }
    const t = trendingEntry(trending, u.symbol);
    await store.addChatterDay({ date: et.date, symbol: u.symbol, perHour: rate.perHour, sampled: msgs.length, spanHours: rate.spanHours, bullishShare: rate.bullishShare, watchers: stream.symbol?.watchlist_count ?? null, trendingRank: t?.rank ?? null });
    report.measured++;
    const history = await store.chatterHistory(u.symbol, et.date, CHATTER.lookbackDays);
    const sc = spikeScore(history.map((h) => h.perHour), rate.perHour);
    const recentSpike = sc && sc.z >= CHATTER.spikeZ ? await store.chatterSpikeSince(u.symbol, addDays(et.date, -CHATTER.episodeGapDays)) : false;
    if (sc && sc.z >= CHATTER.spikeZ && !recentSpike) {
      await store.addChatterEvent({ date: et.date, symbol: u.symbol, kind: "spike", z: Math.round(sc.z * 100) / 100, perHour: rate.perHour, baselinePerHour: Math.round(sc.baseline * 100) / 100, bullishShare: rate.bullishShare });
      report.spikes.push(u.symbol);
    } else if (sc && sc.z < 1 && isControlDay(et.date, u.symbol)) {
      await store.addChatterEvent({ date: et.date, symbol: u.symbol, kind: "control", z: Math.round(sc.z * 100) / 100, perHour: rate.perHour, baselinePerHour: Math.round(sc.baseline * 100) / 100, bullishShare: rate.bullishShare });
      report.controls++;
    }
  }
  report.remaining = todo.length - report.measured;
  return report;
}

/** After the close: make sure daily bars exist for the chatter universe, SPY and the sector funds from `from` (incremental). */
export async function ensureChatterBars(data: MarketData, now: Date, from: string): Promise<number> {
  const et = toEt(now);
  const symbols = [...new Set(["SPY", ...CHATTER_UNIVERSE.map((u) => u.etf), ...CHATTER_UNIVERSE.map((u) => u.symbol)])];
  const have = await store.loadBars([CHATTER_UNIVERSE[0].symbol], from, et.date);
  const start = have.length && have[0].date <= addDays(from, 7) ? addDays(have[have.length - 1].date, -4) : from;
  if (start > et.date) return 0;
  const bars = await data.getDailyBars(symbols, start, et.date);
  return store.upsertBars(bars.filter((b) => b.date < et.date || et.minutes >= 16 * 60 + 15));
}

/** After the close: earnings-release dates for the 198 stocks from SEC filings (needs SEC_USER_AGENT). */
export async function refreshEarningsDates(env: NodeJS.ProcessEnv, from: string, fetchImpl?: typeof fetch): Promise<{ symbols: number; dates: number; missing: string[] } | string> {
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return "skipped: SEC_USER_AGENT not set";
  let symbols = 0, dates = 0;
  const missing: string[] = [];
  for (const u of CHATTER_UNIVERSE) {
    try {
      const d = await fetchEarningsDates(u.symbol, from, ua, fetchImpl);
      if (d === null) {
        missing.push(u.symbol);
        continue;
      }
      await store.addEarningsDates(u.symbol, d);
      symbols++;
      dates += d.length;
    } catch {
      missing.push(u.symbol);
    }
  }
  return { symbols, dates, missing };
}
