/**
 * What the stock has already done when a card is researched, measured by code: the last close, the day's move, and
 * any move after the close or before the open. Without it a card written in the evening about news from 4 PM cannot
 * know the market has already reacted (ALTG, Nov 23 2026: a deal announced at the close, the stock up 13% after
 * hours, and a card at 10:15 PM calling it overlooked).
 *
 * Prices are the whole market's (15 minutes delayed on the free plan), so a thin stock with no trade on one exchange
 * is still seen. Changing what this tells the model changes research input: bump PRICE_CHECK_REVISION (it is part
 * of the scout's version).
 */
import type { DailyBar, MarketData, MinuteBar } from "../alpaca";
import { addDays, toEt } from "../time";

export const PRICE_CHECK_REVISION = 2;

export interface PriceCheck {
  symbol: string;
  /** The last regular-session close, its date, and that day's move in %. */
  close: number; closeDate: string; dayPct: number | null;
  /** True when the regular session of `closeDate` is still open (the "close" is the price so far). */
  inSession: boolean;
  /** The latest extended-hours price since that close, when it was, and the move against the close in %. */
  ext: { price: number; at: string; pct: number; trades: number } | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: the price check from daily bars (oldest first) and the 1-minute bars since the last close. */
export function priceCheck(symbol: string, daily: DailyBar[], minute: MinuteBar[], now: Date): PriceCheck | null {
  const bars = daily.filter((b) => b.symbol === symbol).sort((a, b) => a.date.localeCompare(b.date));
  const last = bars.at(-1);
  if (!last) return null;
  const prev = bars.at(-2) ?? null;
  const et = toEt(now);
  const inSession = last.date === et.date && et.minutes >= 9 * 60 + 30 && et.minutes < 16 * 60;
  // Extended hours: trades after 4 PM ET on the close's day, or any time on a later day before that day's open.
  const after = inSession ? [] : minute.filter((m) => { const t = toEt(new Date(m.t)); const outside = t.minutes < 9 * 60 + 30 || t.minutes >= 16 * 60; return t.date === last.date ? t.minutes >= 16 * 60 : t.date > last.date && outside; });
  const lastExt = after.at(-1);
  return {
    symbol, close: last.c, closeDate: last.date, dayPct: prev ? r1((last.c / prev.c - 1) * 100) : null, inSession,
    ext: lastExt && last.c > 0 ? { price: lastExt.c, at: lastExt.t, pct: r1((lastExt.c / last.c - 1) * 100), trades: after.length } : null,
  };
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const signed = (x: number | null) => (x === null ? "?" : `${x > 0 ? "+" : ""}${x}%`);

/** Pure: the price check as a block for the model. */
export function priceCheckText(p: PriceCheck, now: Date): string {
  const today = toEt(now).date;
  const head = p.inSession
    ? `${p.symbol} is trading at $${p.close.toFixed(2)}, ${signed(p.dayPct)} today so far (15-minute delayed).`
    : `${p.symbol} closed at $${p.close.toFixed(2)} on ${p.closeDate} (${signed(p.dayPct)} on the day).`;
  const ext = p.ext
    ? ` Since that close it has traded at $${p.ext.price.toFixed(2)} (${signed(p.ext.pct)} against the close) as of ${clock(p.ext.at)} ET${toEt(new Date(p.ext.at)).date === today ? "" : ` on ${toEt(new Date(p.ext.at)).date}`}, in ${toEt(new Date(p.ext.at)).date > p.closeDate ? "pre-market" : "after-hours"} trading (thin, 15-minute delayed).`
    : p.inSession ? "" : " No trade after that close was seen.";
  const big = Math.max(Math.abs(p.inSession ? p.dayPct ?? 0 : 0), Math.abs(p.ext?.pct ?? 0), Math.abs(!p.inSession ? p.dayPct ?? 0 : 0));
  const so = big >= 5
    ? " A move this size after the news is the market already reacting. Say so in the observation, judge \"why not priced\" against the price after the move, and do not call the news overlooked."
    : " There is no large move so far.";
  return `PRICE CHECK (measured by the scout's code now; not a source): ${head}${ext}${so} The paper entry is the next open, so anything that has already moved is not the card's to gain.`;
}

/**
 * Pure: how far the stock has moved over the last week, month and quarter, against SPY. Cards kept listing this as
 * an unknown ("the price history was not measured here") although the scout has the prices.
 */
export function trailingMoves(symbol: string, bars: DailyBar[], today: string): string | null {
  const of = (sym: string) => bars.filter((b) => b.symbol === sym).sort((a, b) => a.date.localeCompare(b.date));
  const move = (list: DailyBar[], days: number): number | null => {
    const last = list.at(-1), base = list.filter((b) => b.date <= addDays(today, -days)).at(-1);
    return last && base && base.c > 0 && base.date < last.date ? r1((last.c / base.c - 1) * 100) : null;
  };
  const mine = of(symbol), spy = of("SPY");
  if (mine.length < 5) return null;
  const parts = ([[7, "7 days"], [30, "30 days"], [90, "90 days"]] as const).map(([d, label]) => {
    const m = move(mine, d), s = move(spy, d);
    return m === null ? null : `${signed(m)} over ${label}${s === null ? "" : ` (SPY ${signed(s)})`}`;
  }).filter(Boolean);
  if (!parts.length) return null;
  const high = Math.max(...mine.map((b) => b.h ?? b.c)), last = mine.at(-1)!;
  const off = high > 0 ? r1((last.c / high - 1) * 100) : null;
  return `PRICE HISTORY (measured by the scout's code; closes to ${last.date}): ${symbol} is ${parts.join(", ")}${off !== null && off < -1 ? `; ${signed(off)} from its high of the last ${mine.length} sessions` : ""}. Do not list the recent price moves as unknown.`;
}

/** The price check for one stock at research time; null when prices are not set up or nothing is found. Never throws. */
export async function priceCheckLine(data: MarketData | null, symbol: string | undefined, now: Date): Promise<string | null> {
  if (!data || !symbol) return null;
  try {
    const today = toEt(now).date;
    const daily = await data.getDailyBars([symbol], addDays(today, -10), today, { feed: "sip", adjustment: "raw" });
    const last = daily.filter((b) => b.symbol === symbol).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (!last) return null;
    // From an hour before the earliest possible 4 PM ET close (8 PM UTC in summer) on the close's day, to now.
    const minute = data.getMinuteBars ? await data.getMinuteBars(symbol, new Date(`${last.date}T19:55:00Z`), now, "sip").catch(() => [] as MinuteBar[]) : [];
    const p = priceCheck(symbol, daily, minute, now);
    // The longer history rides along (split-adjusted, with SPY for comparison); the check stands without it.
    const history = await data.getDailyBars([symbol, "SPY"], addDays(today, -130), today, { feed: "sip", adjustment: "all" }).then((b) => trailingMoves(symbol, b, today)).catch(() => null);
    return p ? `${priceCheckText(p, now)}${history ? `\n${history}` : ""}` : history;
  } catch {
    return null;
  }
}
