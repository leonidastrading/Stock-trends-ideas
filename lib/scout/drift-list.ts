/**
 * The Drift list's own paper book: every setup is a paper short from the moment it first appears on the page. No card
 * and no AI are needed: the list itself is the call, so it is scored as one.
 *
 * Entry: the price at the scan that listed the setup, when the market is open (the scan's latest price, which can be
 * a few minutes old); listed while the market is closed, it enters at the next session's open. Held 28 calendar days
 * (the desk's hold), then closed at that session's close. Against SPY over the same span. Nothing is entered before
 * the setup was visible, and a setup that leaves the list keeps its paper short until the time is up.
 *
 * Setups that were already on the list when this book started (November 25, 2026) are entered at the 1-minute bar
 * from the time they were first listed, which the scout had recorded; they are marked "minute bar".
 */
import type { DailyBar, MarketData } from "../alpaca";
import { query as q } from "../db";
import { addDays, toEt } from "../time";
import { DRIFT, type DriftSetup } from "./drift";
import { paperResult, vsSpy } from "./paper-result";
import * as store from "./store";
import { beforeOpen } from "./tracking";

/** `freshMin`: a setup listed within this many minutes is entered at the scan's own price (the whole market's minute bars are only free after 15). */
export const DRIFT_LIST = { holdDays: DRIFT.holdCalendarDays, freshMin: 20 };

export type Basis = "listing" | "minute bar" | "open";
export interface ListEntry {
  symbol: string; eventDate: string; eventKind: string; headline: string; url: string | null;
  /** When the setup first appeared on the page. */
  listedAt: string;
  entryDate: string | null; entryPrice: number | null; spyEntry: number | null;
  /** Where the entry price came from: the scan that listed it, the 1-minute bar at that time, or the next open. */
  basis: Basis;
  exitBy: string | null; exitDate: string | null; exitPrice: number | null; spyExit: number | null;
}

export const listKey = (s: { symbol: string; eventDate: string }) => `${s.symbol}|${s.eventDate}`;

/** Pure: whether the regular session is open at this moment (weekday, 9:30 AM to 4 PM ET; holidays are the caller's check). */
export function inSession(at: Date): boolean {
  const e = toEt(at);
  return e.weekday >= 1 && e.weekday <= 5 && e.minutes >= 9 * 60 + 30 && e.minutes < 16 * 60;
}

type Bar = Pick<DailyBar, "date" | "o" | "c">;

/** Pure: the session a setup listed outside market hours enters at (the open of the day it was listed before, else the next one). */
export function openEntry(listedAt: string, bars: Bar[]): { date: string; price: number } | null {
  const day = toEt(new Date(listedAt)).date;
  const bar = beforeOpen(day, listedAt) ? bars.find((b) => b.date >= day) : bars.find((b) => b.date > day);
  return bar && bar.o > 0 ? { date: bar.date, price: bar.o } : null;
}

/** Pure: the bars an entry may use: today's only once the session has opened (a bar that shows up before the bell has no open yet). */
export function openedBars<T extends { date: string }>(bars: T[], now: Date): T[] {
  const et = toEt(now);
  return bars.filter((b) => b.date < et.date || (b.date === et.date && et.minutes >= 9 * 60 + 31));
}

/** Pure: the exit, once the hold is up: the close of the first finished session on or after the exit day. */
export function timeExit(exitBy: string, bars: Bar[], today: string): { date: string; price: number } | null {
  const bar = bars.find((b) => b.date >= exitBy && b.date < today);
  return bar && bar.c > 0 ? { date: bar.date, price: bar.c } : null;
}

/** Pure: the paper short's return and SPY's over the same span (null before it has entered). */
export function listResult(e: ListEntry, priceNow: number | null, spyNow: number | null, now = new Date()) {
  const r = paperResult({ entryPrice: e.entryPrice, entryDate: e.entryDate, exitDate: e.exitDate, exitPrice: e.exitPrice, direction: "short", spyEntry: e.spyEntry, spyExit: e.spyExit }, priceNow, spyNow, now);
  return r ? { ...r, vsSpy: vsSpy("short", r) } : null;
}

const day = (v: unknown) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** The entry on today's prices: as recorded, times any split since (the recorded price is kept in the table). */
const adjusted = (r: Record<string, unknown>) => (num(r.entry_price) === null ? null : Math.round(num(r.entry_price)! * Number(r.split_factor ?? 1) * 1e4) / 1e4);
const toEntry = (r: Record<string, unknown>): ListEntry => ({
  symbol: String(r.symbol), eventDate: day(r.event_date)!, eventKind: String(r.event_kind ?? ""), headline: String(r.headline ?? ""), url: (r.url as string) ?? null,
  listedAt: new Date(r.listed_at as string).toISOString(), entryDate: day(r.entry_date), entryPrice: adjusted(r), spyEntry: num(r.spy_entry), basis: r.basis as Basis,
  exitBy: day(r.exit_by), exitDate: day(r.exit_date), exitPrice: num(r.exit_price), spyExit: num(r.spy_exit),
});

/** Every paper short from the list, newest first. */
export async function listBook(days = 240): Promise<ListEntry[]> {
  return (await q(`SELECT * FROM drift_list WHERE listed_at >= now() - ($1::int * interval '1 day') ORDER BY listed_at DESC`, [days])).map(toEntry);
}

/**
 * Enter a paper short for every setup that has none. `firstSeen` is when each setup first appeared on the page (the
 * scan records it); one listed in the last minutes enters at the scan's price, an older one at the 1-minute bar from
 * the time it was listed, and one listed while the market was closed waits for the next open.
 */
export async function recordListings(setups: DriftSetup[], firstSeen: Record<string, string>, ctx: { data: MarketData; now: Date; today: string }): Promise<number> {
  if (!setups.length) return 0;
  const have = new Set((await q(`SELECT symbol, event_date FROM drift_list WHERE symbol = ANY($1)`, [setups.map((s) => s.symbol)])).map((r) => `${r.symbol}|${day(r.event_date)}`));
  let n = 0, spyNow: number | null | undefined;
  for (const s of setups) {
    if (have.has(listKey(s))) continue;
    const listedAt = firstSeen[listKey(s)] ?? ctx.now.toISOString();
    const at = new Date(listedAt), justNow = ctx.now.getTime() - at.getTime() <= DRIFT_LIST.freshMin * 60000;
    let entry: { date: string; price: number; spy: number | null; basis: Basis } | null = null;
    if (justNow) {
      // Listed by the scan that just ran, market open and today's price in hand: in at that price.
      if (inSession(ctx.now) && s.asOf === ctx.today && s.price > 0) {
        if (spyNow === undefined) spyNow = ctx.data.getSnapshots ? (await ctx.data.getSnapshots(["SPY"]).catch(() => ({} as Record<string, { price: number }>))).SPY?.price ?? null : null;
        entry = { date: ctx.today, price: s.price, spy: spyNow, basis: "listing" };
      }
    } else if (inSession(at) && ctx.data.getMinuteBars) {
      // Listed earlier (before this book started, or a pass was missed): the price at the minute it was listed.
      const from = new Date(at.getTime() - 20 * 60000);
      const last = async (sym: string) => (await ctx.data.getMinuteBars!(sym, from, new Date(at.getTime() + 60000), "sip").catch(() => [])).filter((b) => b.t <= listedAt).at(-1)?.c ?? null;
      const price = await last(s.symbol);
      if (price) entry = { date: toEt(at).date, price, spy: await last("SPY"), basis: "minute bar" };
    }
    await q(
      `INSERT INTO drift_list (symbol, event_date, event_kind, headline, url, listed_at, entry_date, entry_price, spy_entry, basis, exit_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (symbol, event_date) DO NOTHING`,
      [s.symbol, s.eventDate, s.eventKind, s.eventHeadline.slice(0, 300), s.eventUrl, listedAt, entry?.date ?? null, entry?.price ?? null, entry?.spy ?? null, entry?.basis ?? "open", entry ? addDays(entry.date, DRIFT_LIST.holdDays) : null],
    );
    n++;
  }
  return n;
}

/** One pass (its own job, every ten minutes): paper shorts for the setups on the list that have none, then entries and exits that are due. */
export async function updateListBook(data: MarketData, now = new Date()): Promise<string> {
  const [scan, seen] = await Promise.all([store.cacheGet<{ setups: DriftSetup[] }>("drift"), store.cacheGet<Record<string, string>>("drift:first-seen")]);
  const added = await recordListings(scan?.data?.setups ?? [], seen?.data ?? {}, { data, now, today: toEt(now).date });
  const settled = await settleList(data, now);
  // A split since an entry (checked hourly): the entry is put on today's prices.
  if (await store.tryLock("drift-list:splits", 60).catch(() => false)) {
    const { adjustBookForSplits } = await import("./price-sanity");
    const notes = await adjustBookForSplits(data, { table: "drift_list", key: "event_date" }, toEt(now).date).catch(() => []);
    if (notes.length) console.log(`drift list splits: ${notes.join("; ")}`);
  }
  const open = await q(`SELECT symbol, entry_price, basis FROM drift_list WHERE exit_date IS NULL ORDER BY listed_at DESC`).catch(() => []);
  return `${added} new, ${settled.entered} entered at an open, ${settled.closed} closed · ${open.length} open (${open.slice(0, 14).map((r) => `${r.symbol} ${r.entry_price === null ? "waits for the open" : `$${Number(r.entry_price).toFixed(2)}${r.basis === "minute bar" ? " 1-min" : ""}`}`).join(", ")})`;
}

/** Fill the entries waiting for an open, and close the shorts whose time is up. */
export async function settleList(data: MarketData, now: Date): Promise<{ entered: number; closed: number }> {
  const open = (await q(`SELECT * FROM drift_list WHERE exit_date IS NULL`)).map(toEntry);
  const today = toEt(now).date;
  const due = open.filter((e) => !e.entryDate || (e.exitBy && e.exitBy < today));
  if (!due.length) return { entered: 0, closed: 0 };
  const from = addDays(due.reduce((m, e) => { const d = e.entryDate ?? toEt(new Date(e.listedAt)).date; return d < m ? d : m; }, today), -3);
  const all = await data.getDailyBars([...new Set(due.map((e) => e.symbol)), "SPY"], from, today, { feed: "sip" });
  const of = (sym: string) => all.filter((b) => b.symbol === sym).sort((a, b) => a.date.localeCompare(b.date));
  const spy = of("SPY");
  let entered = 0, closed = 0;
  for (const e of due) {
    const bars = of(e.symbol);
    if (!e.entryDate) {
      const x = openEntry(e.listedAt, openedBars(bars, now));
      if (!x) continue;
      await q(`UPDATE drift_list SET entry_date = $3, entry_price = $4, spy_entry = $5, exit_by = $6 WHERE symbol = $1 AND event_date = $2 AND entry_date IS NULL`, [e.symbol, e.eventDate, x.date, x.price, spy.find((b) => b.date === x.date)?.o ?? null, addDays(x.date, DRIFT_LIST.holdDays)]);
      entered++;
    } else if (e.exitBy) {
      const x = timeExit(e.exitBy, bars, today);
      if (!x) continue;
      await q(`UPDATE drift_list SET exit_date = $3, exit_price = $4, spy_exit = $5 WHERE symbol = $1 AND event_date = $2 AND exit_date IS NULL`, [e.symbol, e.eventDate, x.date, x.price, spy.find((b) => b.date === x.date)?.c ?? null]);
      closed++;
    }
  }
  return { entered, closed };
}
