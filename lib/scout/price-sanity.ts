/**
 * Price sanity for paper entries and marks.
 *
 * A paper entry is recorded once, at the price the stock traded at that day. Two things can make it wrong later:
 * a split (SanDisk's 8-for-1 on November 20, 2026 left an entry of $826.87 beside prices near $80, which read as a
 * 92% loss), and a bad price (a stale or mistaken print). Both are checked against the whole market's daily bars,
 * fetched twice: as traded, and adjusted for splits as of today.
 *
 * - The split factor since a day is the adjusted close over the as-traded close that day. It needs no stored
 *   history, so it cannot be hidden by the stored bars being refreshed (which is how the SanDisk split was missed:
 *   the entry day's stored bar had already been rewritten on the new prices when the two were compared).
 * - A recorded entry has to sit inside that day's traded range. If it does not, the call is "price unverified" and
 *   stays out of the totals until it does.
 * - A daily close that moved more than 40% against the close before it has to agree with the whole market's close
 *   for that day; otherwise the call is "price unverified".
 *
 * The recorded entry is never changed: the factor sits beside it.
 */
import type { DailyBar, MarketData } from "../alpaca";
import { query as q } from "../db";

export const SANITY = { rangeSlack: 0.05, jump: 0.4, agree: 0.05 };

type Bar = Pick<DailyBar, "date" | "o" | "h" | "l" | "c">;

/** Pure: splits since a day, as today's price over that day's (0.125 after an 8-for-1, 10 after a 1-for-10; 1 when none). */
export function splitFactorSince(rawClose: number, adjClose: number): number {
  const r = adjClose / rawClose;
  if (!Number.isFinite(r) || r <= 0 || Math.abs(r - 1) <= 0.02) return 1;
  return Math.round(r * 1e6) / 1e6;
}

/** Pure: a split factor in words ("8-for-1", "1-for-10"). */
export function splitWords(factor: number): string {
  const n = (x: number) => (Math.abs(x - Math.round(x)) < 0.02 ? String(Math.round(x)) : String(Math.round(x * 100) / 100));
  return factor < 1 ? `${n(1 / factor)}-for-1` : `1-for-${n(factor)}`;
}

/** Pure: is a price inside a day's traded range, with a little slack for a different feed? */
export const inRange = (price: number, bar: Pick<Bar, "h" | "l">, slack = SANITY.rangeSlack) => price >= bar.l * (1 - slack) && price <= bar.h * (1 + slack);

export type EntryVerdict = { kind: "ok"; factor: number; asTraded: boolean } | { kind: "unverified"; note: string };

/**
 * Pure: what a recorded entry is, against its day's bar as traded (`raw`) and as adjusted for splits today (`adj`).
 * Inside the as-traded range: the factor is the splits since. Inside the adjusted range only: it was recorded after
 * the split, on the new prices already (factor 1). Inside neither: unverified. Null when the day has no bar to
 * check against. `basis` is the split factor of the day the result is measured on (1 for an open call, the exit
 * day's for a closed one), so a closed call compares entry and exit on the same prices.
 */
export function entryVerdict(entry: number, raw: Bar | undefined, adj: Bar | undefined, basis = 1): EntryVerdict | null {
  if (!raw || !adj || !(raw.c > 0) || !(adj.c > 0) || !(entry > 0)) return null;
  const f = splitFactorSince(raw.c, adj.c);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  if (inRange(entry, raw)) return { kind: "ok", factor: r6(f / basis), asTraded: true };
  if (f !== 1 && inRange(entry, adj)) return { kind: "ok", factor: r6(1 / basis), asTraded: false };
  return { kind: "unverified", note: `entry $${entry} is outside the range the stock traded in on ${raw.date} ($${raw.l} to $${raw.h})` };
}

/** Pure: a close that moved more than 40% against the close before it needs a second look. */
export const jumped = (prevClose: number, close: number) => prevClose > 0 && Math.abs(close / prevClose - 1) > SANITY.jump;

/** Pure: do two sources' closes for the same day agree? */
export const agree = (a: number, b: number) => b > 0 && Math.abs(a / b - 1) <= SANITY.agree;

export interface SanityBars { raw: Map<string, DailyBar[]>; adj: Map<string, DailyBar[]> }

const group = (bars: DailyBar[]) => {
  const m = new Map<string, DailyBar[]>();
  for (const b of bars) { const a = m.get(b.symbol) ?? []; a.push(b); m.set(b.symbol, a); }
  for (const a of m.values()) a.sort((x, y) => x.date.localeCompare(y.date));
  return m;
};

/** The whole market's daily bars for these stocks, as traded and adjusted for splits as of today. */
export async function sanityBars(data: MarketData, symbols: string[], from: string, today: string): Promise<SanityBars> {
  const [raw, adj] = await Promise.all([data.getDailyBars(symbols, from, today, { feed: "sip", adjustment: "raw" }), data.getDailyBars(symbols, from, today, { feed: "sip", adjustment: "split" })]);
  return { raw: group(raw), adj: group(adj) };
}

/**
 * The same check for a study book that keeps its own entries (the Drift list, Upgrades): each open row's split
 * factor is set from the bars. Returns a note per row changed.
 */
export async function adjustBookForSplits(data: MarketData, book: { table: "drift_list" | "upgrade_list"; key: "event_date" | "day" }, today: string): Promise<string[]> {
  const rows = await q(`SELECT symbol, ${book.key}::text AS k, entry_date::text AS entry_date, entry_price, split_factor FROM ${book.table} WHERE entry_date IS NOT NULL AND entry_price IS NOT NULL AND exit_date IS NULL`);
  if (!rows.length) return [];
  const from = rows.map((r) => String(r.entry_date).slice(0, 10)).sort()[0];
  const bars = await sanityBars(data, [...new Set(rows.map((r) => String(r.symbol)))], from, today);
  const notes: string[] = [];
  for (const r of rows) {
    const d = String(r.entry_date).slice(0, 10), sym = String(r.symbol);
    const v = entryVerdict(Number(r.entry_price), bars.raw.get(sym)?.find((b) => b.date === d), bars.adj.get(sym)?.find((b) => b.date === d));
    if (!v || v.kind !== "ok" || Math.abs(v.factor / Number(r.split_factor ?? 1) - 1) <= 0.02) continue;
    await q(`UPDATE ${book.table} SET split_factor = $3 WHERE symbol = $1 AND ${book.key} = $2`, [sym, String(r.k).slice(0, 10), v.factor]);
    notes.push(`${sym}: ${splitWords(v.factor)} split since ${d}`);
  }
  return notes;
}

export type Borrow = "easy" | "hard" | "not shortable";

/** Pure: the borrow reading from the broker's asset record (null when it does not say). */
export function borrowOf(a: { shortable?: boolean; easyToBorrow?: boolean } | null | undefined): Borrow | null {
  if (!a || typeof a.shortable !== "boolean") return null;
  return !a.shortable ? "not shortable" : a.easyToBorrow ? "easy" : "hard";
}

/**
 * Paper shorts ignore whether the shares could be borrowed. For each short entered today or yesterday with no
 * reading yet, the broker's record is kept beside it: on the easy-to-borrow list, shortable but hard to borrow, or
 * not shortable. It is a reading from the day of the entry, never filled in later for older shorts. Card shorts and
 * the Drift list's shorts both.
 */
export async function recordBorrow(data: MarketData, today: string): Promise<string> {
  if (!data.getAsset) return "borrow: no asset data";
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const cards = await q(`SELECT card_id, symbol FROM tracks WHERE direction = 'short' AND borrow IS NULL AND entry_date >= $1`, [since]);
  const list = await q(`SELECT symbol, event_date::text AS k FROM drift_list WHERE borrow IS NULL AND entry_date >= $1`, [since]);
  const seen = new Map<string, Borrow | null>();
  const read = async (sym: string) => { if (!seen.has(sym)) seen.set(sym, borrowOf(await data.getAsset!(sym).catch(() => null))); return seen.get(sym)!; };
  let n = 0;
  for (const r of cards) { const b = await read(String(r.symbol)); if (b) { await q(`UPDATE tracks SET borrow = $2 WHERE card_id = $1 AND borrow IS NULL`, [r.card_id, b]); n++; } }
  for (const r of list) { const b = await read(String(r.symbol)); if (b) { await q(`UPDATE drift_list SET borrow = $3 WHERE symbol = $1 AND event_date = $2 AND borrow IS NULL`, [r.symbol, String(r.k).slice(0, 10), b]); n++; } }
  const hard = [...seen].filter(([, b]) => b && b !== "easy").map(([s, b]) => `${s} ${b}`);
  return `borrow: ${n} new short${n === 1 ? "" : "s"} read${hard.length ? ` (${hard.join(", ")})` : ""}`;
}
