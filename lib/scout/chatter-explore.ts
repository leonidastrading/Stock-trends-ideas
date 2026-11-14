/**
 * Look-back pass for the chatter test: Stocktwits' message-volume history
 * (daily, 3 months, fetched once through the Stocktwits connector into
 * data/chatter-explore/) run through the same spike rule and outcome math as
 * the forward test.
 *
 * Exploratory only, never card evidence and never part of a verdict:
 * - the history is a 0-100 score scaled over the whole window it was fetched
 *   for, so part of each day's value depends on later days;
 * - it is smoothed (it moves like a rolling average), so a spike shows late;
 * - there is no sentiment in it, so every spike counts as "mixed".
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHATTER, CHATTER_UNIVERSE } from "@/config/chatter";
import type { DailyBar } from "../alpaca";
import { eventOutcome, isControlDay, type Outcome, spikeScore } from "./chatter";

export interface ExploreFile { source: string; fetched: string; series: Record<string, Array<[string, number]>>; failed?: unknown[] }

export function loadExplore(dir = join(/* turbopackIgnore: true */ process.cwd(), "data", "chatter-explore")): { series: Record<string, Array<[string, number]>>; fetched: string | null; files: number; dropped: string[] } {
  const series: Record<string, Array<[string, number]>> = {};
  let fetched: string | null = null;
  let files = 0;
  try {
    for (const f of readdirSync(/* turbopackIgnore: true */ dir).filter((x) => /^part-\d+\.json$/.test(x)).sort()) {
      const d = JSON.parse(readFileSync(/* turbopackIgnore: true */ join(dir, f), "utf8")) as ExploreFile;
      Object.assign(series, d.series);
      fetched = d.fetched ?? fetched;
      files++;
    }
  } catch {
    /* no data yet */
  }
  const { kept, dropped } = cleanSeries(series);
  return { series: kept, fetched, files, dropped };
}

/**
 * Pure: drop series that cannot be read as chatter: too short (the history stopped, e.g. a delisting)
 * or mostly zeros (a symbol that was dark and then remapped, e.g. 0 for months then 100).
 */
export function cleanSeries(series: Record<string, Array<[string, number]>>): { kept: Record<string, Array<[string, number]>>; dropped: string[] } {
  const kept: Record<string, Array<[string, number]>> = {};
  const dropped: string[] = [];
  for (const [sym, pts] of Object.entries(series)) {
    const zeros = pts.filter((p) => p[1] === 0).length;
    if (pts.length < 45 || zeros > pts.length * 0.3) dropped.push(sym);
    else kept[sym] = pts;
  }
  return { kept, dropped: dropped.sort() };
}

export interface ExploreEvent { date: string; symbol: string; kind: "spike" | "control"; z: number; value: number }

/** Pure: spikes (z >= 2.5 on the raw score, the first in 5 sessions) and hash-picked controls, each judged only on earlier points. */
export function exploreEvents(series: Record<string, Array<[string, number]>>): ExploreEvent[] {
  const out: ExploreEvent[] = [];
  for (const [symbol, pts] of Object.entries(series)) {
    const s = pts.slice().sort((a, b) => a[0].localeCompare(b[0]));
    let lastSpike = -Infinity;
    for (let i = 0; i < s.length; i++) {
      const sc = spikeScore(s.slice(0, i).map((p) => p[1]), s[i][1], { log: false });
      if (!sc) continue;
      if (sc.z >= CHATTER.spikeZ) {
        if (i - lastSpike > CHATTER.episodeGapDays) out.push({ date: s[i][0], symbol, kind: "spike", z: Math.round(sc.z * 100) / 100, value: s[i][1] });
        lastSpike = i;
      } else if (sc.z < 1 && isControlDay(s[i][0], symbol)) out.push({ date: s[i][0], symbol, kind: "control", z: Math.round(sc.z * 100) / 100, value: s[i][1] });
    }
  }
  return out;
}

/** Outcomes for the look-back events from stored bars. The score is end-of-day, so entry is the next open. */
export function exploreOutcomes(events: ExploreEvent[], bars: Map<string, DailyBar[]>): Array<ExploreEvent & { outcome: Outcome | null }> {
  const etf = new Map(CHATTER_UNIVERSE.map((u) => [u.symbol, u.etf]));
  return events.map((e) => ({ ...e, outcome: eventOutcome(e.date, bars.get(e.symbol) ?? [], bars.get("SPY") ?? [], bars.get(etf.get(e.symbol) ?? "") ?? []) }));
}
