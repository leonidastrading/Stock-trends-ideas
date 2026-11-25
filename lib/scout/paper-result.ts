import type { Track } from "./store";
import { daysBetween, toEt } from "../time";

/** Pure: the trade's return beyond SPY (see excessReturn: for a short, SPY's move minus the stock's). */
export const vsSpy = (direction: "long" | "short", r: { ret: number; spy: number | null }): number | null => (r.spy === null ? null : direction === "short" ? r.ret + r.spy : r.ret - r.spy);

/** Pure: the paper trade's return (direction-adjusted) and SPY's over the same span, or null before entry. */
export function paperResult(t: Pick<Track, "entryPrice" | "entryDate" | "exitDate" | "exitPrice" | "direction" | "spyEntry" | "spyExit">, priceNow: number | null, spyNow: number | null, now = new Date()): { ret: number; spy: number | null; closed: boolean; days: number } | null {
  if (!t.entryPrice || !t.entryDate) return null;
  const closed = !!t.exitDate && t.exitPrice !== null;
  const end = closed ? t.exitPrice! : priceNow;
  if (!end) return null;
  const sign = t.direction === "short" ? -1 : 1;
  const spyEnd = closed ? t.spyExit : spyNow;
  return { ret: sign * (end / t.entryPrice - 1), spy: t.spyEntry && spyEnd ? spyEnd / t.spyEntry - 1 : null, closed, days: Math.max(0, daysBetween(t.entryDate, closed ? t.exitDate! : toEt(now).date)) };
}

