/**
 * Paper tracking. Entry is the next open after the card is written: the same day's open for a card written before
 * 9:30 AM ET on a trading day, otherwise the next session's.
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

/** Common split ratios (forward and reverse), as fresh price / stored price. */
export const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100, 1.5, 2.5].flatMap((r) => [1 / r, r]);

/**
 * Pure: comparing a fresh split-adjusted close with the stored close for the same day. "same" within 2%; "split"
 * with the ratio when it is a standard split ratio within 3%; otherwise "mismatch" (bad or changed data).
 */
export function splitCheck(fresh: number, stored: number): { kind: "same" } | { kind: "split"; ratio: number } | { kind: "mismatch"; ratio: number } {
  const r = fresh / stored;
  if (Math.abs(r - 1) <= 0.02) return { kind: "same" };
  const near = SPLIT_RATIOS.find((s) => Math.abs(r / s - 1) <= 0.03);
  return near ? { kind: "split", ratio: near } : { kind: "mismatch", ratio: Math.round(r * 1000) / 1000 };
}

/**
 * Stored prices are fetched once and only the last few days are re-fetched, so a split leaves the stored history
 * with old prices before it and new ones after, and an entry recorded before it no longer compares (a 5-for-1 split
 * looked like an 80% crash). For each open track, the fresh split-adjusted close on its entry day is compared with
 * the stored one: a split rewrites the stock's stored history and scales the track's entry; any other disagreement
 * marks the track for a price check (left out of the points).
 */
export async function reconcileSplits(data: MarketData, open: Track[], today: string): Promise<string[]> {
  const notes: string[] = [];
  const entered = open.filter((t) => t.entryDate);
  if (!entered.length) return notes;
  const syms = [...new Set(entered.map((t) => t.symbol))];
  const earliest = entered.map((t) => t.entryDate!).sort()[0];
  const fresh = await data.getDailyBars(syms, earliest, today).catch(() => null);
  if (!fresh) return notes;
  const stored = groupBars(await store.loadBars(syms, earliest, today));
  const rewritten = new Set<string>();
  for (const t of entered) {
    const f = fresh.find((b) => b.symbol === t.symbol && b.date === t.entryDate);
    const s = barOn(stored.get(t.symbol), t.entryDate!);
    if (!f || !s) continue;
    const c = splitCheck(f.c, s.c);
    if (c.kind === "same") { if (t.priceCheck) await store.setPriceCheck(t.cardId, null); continue; }
    if (c.kind === "split") {
      if (!rewritten.has(t.symbol)) { await store.upsertBars(fresh.filter((b) => b.symbol === t.symbol)); rewritten.add(t.symbol); }
      await store.applySplit(t.cardId, c.ratio);
      await store.addTrackEvent(t.cardId, "split", `${t.symbol}: prices now ${c.ratio > 1 ? `${c.ratio}x` : `1/${Math.round(1 / c.ratio)}`} of the stored ones on ${t.entryDate} (a split); entry put on the adjusted prices, raw entry kept`);
      notes.push(`card #${t.cardId} ${t.symbol}: split ${c.ratio}`);
    } else if (!t.priceCheck) {
      const note = `${t.symbol} on ${t.entryDate}: fresh close ${f.c} vs stored ${s.c} (x${c.ratio}), not a standard split`;
      await store.setPriceCheck(t.cardId, note);
      notes.push(`card #${t.cardId} price check: ${note}`);
    }
  }
  return notes;
}

/** Pure: is the card written before that day's 9:30 AM ET open? */
export function beforeOpen(cardDate: string, cardAt: string | null | undefined): boolean {
  if (!cardAt) return false;
  const e = toEt(new Date(cardAt));
  return e.date === cardDate && e.minutes < 9 * 60 + 30;
}

/** Pure: the session a card enters at: the next open after it was written. */
export const entryBar = (bars: DailyBarRow[] | undefined, cardDate: string, cardAt: string | null | undefined) =>
  beforeOpen(cardDate, cardAt) ? firstBarFrom(bars, cardDate) : firstBarAfter(bars, cardDate);

export const signedReturn = (direction: "long" | "short", entry: number, exit: number) => (direction === "long" ? 1 : -1) * (exit / entry - 1);

/**
 * Pure: the trade's return beyond the benchmark (SPY or the sector fund) over the same days. A long beats it by rising
 * more; a short beats it by falling more, so its excess is the benchmark's move minus the stock's move, which is the
 * short's return plus the benchmark's move. (Until Nov 2026 shorts used return minus benchmark, which counted a
 * falling market as the short's own edge, and a rising one twice against it.)
 */
export const excessReturn = (direction: "long" | "short", signedRet: number, benchRet: number) => (direction === "short" ? signedRet + benchRet : signedRet - benchRet);

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

  // A reused ticker: an open track whose symbol now trades as a preferred, warrant or note (or not at all) is excluded.
  if (data.getAsset) {
    const { notCommon } = await import("./identity");
    for (const t of tracks.filter((x) => !x.exitDate && !x.excluded)) {
      const asset = await data.getAsset(t.symbol).catch(() => undefined);
      if (asset === undefined) continue;
      const nc = asset ? notCommon(asset.name) : null;
      if (asset && asset.tradable && !nc) continue;
      const why = asset ? `${t.symbol} now trades as "${asset.name}"${nc ? `, a ${nc} security` : ", not tradable"}, not the company the card is about` : `${t.symbol} is no longer a listed symbol`;
      await store.addTrackEvent(t.cardId, "excluded", `automatic: ${why}`);
      t.excluded = why;
      report.notes.push(`card #${t.cardId} excluded: ${why}`);
    }
  }

  let open = tracks.filter((t) => !t.exitDate);
  if (!open.length) return report;
  // Splits since entry (or prices that no longer agree) before anything is measured.
  const splitNotes = await reconcileSplits(data, open, et.date).catch((e) => [`split check failed: ${e instanceof Error ? e.message : e}`]);
  if (splitNotes.length) {
    report.notes.push(...splitNotes);
    const fresh = new Map((await store.allTracks()).map((t) => [t.cardId, t]));
    open = open.map((t) => fresh.get(t.cardId) ?? t);
  }
  const need = [...new Set(open.flatMap((t) => [t.symbol, "SPY", t.sectorEtf]))];
  const bars = groupBars(await store.loadBars(need, addDays(earliest, -7), et.date));
  const events = await store.trackEvents();
  const invalidatedOn = new Map<number, string>();
  for (const e of events) if (e.kind === "invalidated" && !invalidatedOn.has(e.cardId)) invalidatedOn.set(e.cardId, toEt(new Date(e.at)).date);

  for (const t of open) {
    let track = t;
    if (!track.entryDate) {
      const bar = entryBar(bars.get(t.symbol), t.cardDate, t.cardAt);
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
