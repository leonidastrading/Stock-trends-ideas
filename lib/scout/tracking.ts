/**
 * Paper tracking. Entry is the open of the first session after the card.
 * Exit is the open of the first session at or after the earlier of: the day
 * after the catalyst, the time limit, or the day after Vadim marked the
 * invalidation. Nothing here talks to a broker. Pure helpers are exported.
 */
import { SECTOR_KEYS, SECTORS } from "@/config/scout";
import { UNIVERSE } from "@/config/universe";
import type { MarketData } from "../alpaca";
import { addDays, toEt } from "../time";
import * as store from "./store";
import type { DailyBarRow, Track } from "./store";

export type BarsBySymbol = Map<string, DailyBarRow[]>;

export function groupBars(bars: DailyBarRow[]): BarsBySymbol {
  const m: BarsBySymbol = new Map();
  for (const b of bars) {
    const arr = m.get(b.symbol) ?? [];
    arr.push(b);
    m.set(b.symbol, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return m;
}

/** First bar strictly after `date`. */
export const firstBarAfter = (bars: DailyBarRow[] | undefined, date: string) => bars?.find((b) => b.date > date);
/** First bar at or after `date`. */
export const firstBarFrom = (bars: DailyBarRow[] | undefined, date: string) => bars?.find((b) => b.date >= date);
export const barOn = (bars: DailyBarRow[] | undefined, date: string) => bars?.find((b) => b.date === date);

export const signedReturn = (direction: "long" | "short", entry: number, exit: number) => (direction === "long" ? 1 : -1) * (exit / entry - 1);

/** Worst close-to-entry drawdown while held, as a negative percentage (0 if never under water). */
export function maxDrawdownPct(direction: "long" | "short", entry: number, bars: DailyBarRow[], from: string, to: string | null): number {
  let worst = 0;
  for (const b of bars) {
    if (b.date < from || (to && b.date > to)) continue;
    const r = signedReturn(direction, entry, direction === "long" ? b.l : b.h);
    if (r < worst) worst = r;
  }
  return Math.round(worst * 1000) / 10;
}

export interface Exit { date: string; price: number; reason: "catalyst" | "time_limit" | "invalidated" }

/** Pure: where a track exits given the bars so far and any invalidation date (ET date it was marked). */
export function findExit(t: Track, bars: DailyBarRow[] | undefined, invalidatedOn: string | null, catalystDate: string | null): Exit | null {
  if (!t.entryDate || !bars) return null;
  const options: Array<{ date: string; reason: Exit["reason"] }> = [{ date: t.deadlineDate, reason: catalystDate && addDays(catalystDate, 1) === t.deadlineDate ? "catalyst" : "time_limit" }];
  if (invalidatedOn) options.push({ date: addDays(invalidatedOn, 1), reason: "invalidated" });
  options.sort((a, b) => a.date.localeCompare(b.date));
  for (const o of options) {
    if (o.date <= t.entryDate) continue;
    const bar = firstBarFrom(bars, o.date);
    if (bar) return { date: bar.date, price: bar.o, reason: o.reason };
  }
  return null;
}

/** Symbols the tracker needs bars for: tracked stocks, SPY, sector funds, and the baseline universe of each tracked sector. */
export function symbolsNeeded(tracks: Track[], sectorsUsed: string[]): string[] {
  const s = new Set<string>(["SPY", ...Object.values(SECTORS)]);
  for (const t of tracks) s.add(t.symbol);
  for (const sec of sectorsUsed) if ((SECTOR_KEYS as string[]).includes(sec)) for (const sym of UNIVERSE[sec as keyof typeof UNIVERSE]) s.add(sym);
  return [...s];
}

export interface TrackReport { barsWritten: number; entered: number[]; exited: number[]; open: number; notes: string[] }

/** Ingest daily bars and move every track forward. Idempotent. */
export async function updateTracks(data: MarketData, now: Date): Promise<TrackReport> {
  const report: TrackReport = { barsWritten: 0, entered: [], exited: [], open: 0, notes: [] };
  const et = toEt(now);
  const [tracks, cards] = await Promise.all([store.allTracks(), store.allCards()]);
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const sectors = [...new Set(tracks.map((t) => cardById.get(t.cardId)?.sector).filter((x): x is string => !!x))];
  const symbols = symbolsNeeded(tracks, sectors);

  // Incremental: re-fetch the last few days so late corrections land; the first run reaches back to the first card.
  const last = await store.lastBarDate("SPY");
  const earliest = tracks.map((t) => t.cardDate).sort()[0] ?? et.date;
  const from = last ? addDays(last, -4) : addDays(earliest, -7);
  if (from <= et.date) {
    const bars = await data.getDailyBars(symbols, from, et.date);
    report.barsWritten = await store.upsertBars(bars.filter((b) => b.date < et.date || toEt(now).minutes >= 16 * 60 + 15));
  }

  const open = tracks.filter((t) => !t.exitDate);
  if (!open.length) return report;
  const need = [...new Set(open.flatMap((t) => [t.symbol, "SPY", t.sectorEtf]))];
  const bars = groupBars(await store.loadBars(need, addDays(earliest, -7), et.date));
  const events = await store.trackEvents();
  const invalidatedOn = new Map<number, string>();
  for (const e of events) if (e.kind === "invalidated" && !invalidatedOn.has(e.cardId)) invalidatedOn.set(e.cardId, toEt(new Date(e.at)).date);

  for (const t of open) {
    let track = t;
    if (!track.entryDate) {
      const bar = firstBarAfter(bars.get(t.symbol), t.cardDate);
      if (!bar) continue;
      const e = { entryDate: bar.date, entryPrice: bar.o, spyEntry: barOn(bars.get("SPY"), bar.date)?.o ?? null, sectorEntry: barOn(bars.get(t.sectorEtf), bar.date)?.o ?? null };
      await store.setEntry(t.cardId, e);
      track = { ...t, ...e };
      report.entered.push(t.cardId);
    }
    const sym = bars.get(t.symbol) ?? [];
    const exit = findExit(track, sym, invalidatedOn.get(t.cardId) ?? null, cardById.get(t.cardId)?.catalystDate ?? null);
    const dd = maxDrawdownPct(track.direction, track.entryPrice!, sym, track.entryDate!, exit?.date ?? null);
    if (exit) {
      await store.setExit(t.cardId, { exitDate: exit.date, exitPrice: exit.price, spyExit: barOn(bars.get("SPY"), exit.date)?.o ?? null, sectorExit: barOn(bars.get(t.sectorEtf), exit.date)?.o ?? null, reason: exit.reason, maxDrawdownPct: dd });
      report.exited.push(t.cardId);
    } else {
      await store.setDrawdown(t.cardId, dd);
      report.open++;
    }
  }
  return report;
}
