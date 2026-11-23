/**
 * The earnings calendar tab: a week of reports (Nasdaq's calendar), Monday to Friday, before the open and after the
 * close, biggest companies first, with the scout's cards on each reporting stock.
 */
import type { EarningsReport } from "../sources/earnings-data";

/** Pure: the Monday of the week to show. Weekends show the coming week. */
export function weekMonday(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sunday … 6 Saturday
  const shift = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

/** Pure: the five weekdays from a Monday. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 5 }, (_, i) => { const d = new Date(`${monday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
}

export interface CalEntry extends EarningsReport { score: number; trending: boolean; hasCard: boolean }

/** Pure: a slot's reports by market capitalization, biggest first (unknown size last); flags for trending and carded. */
export function rankReports(rows: EarningsReport[], trending: Set<string>, carded: Set<string>): CalEntry[] {
  // One company, several share classes (CENT and CENTA): keep the first listed.
  const seen = new Set<string>();
  const one = rows.filter((r) => { const k = `${r.name.toLowerCase()}|${r.marketCap ?? r.symbol}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return one
    .map((r) => ({ ...r, trending: trending.has(r.symbol), hasCard: carded.has(r.symbol), score: r.marketCap ?? -1 }))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

/** Pure: a day's reports by slot. Unconfirmed times go to their own list. */
export function bySlot(rows: EarningsReport[]): Record<"before_open" | "after_close" | "unknown", EarningsReport[]> {
  return { before_open: rows.filter((r) => r.timing === "before_open"), after_close: rows.filter((r) => r.timing === "after_close"), unknown: rows.filter((r) => r.timing === "unknown") };
}
