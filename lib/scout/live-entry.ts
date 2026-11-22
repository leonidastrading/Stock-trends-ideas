/**
 * Entry at the time of the card: when a card is written while the regular session is open, its paper trade enters
 * right then at the live price (with SPY and the sector fund at their live prices, so the comparison starts at the
 * same moment). When the market is closed, the trade enters at the next open as before (pre-market: that day's open).
 */
import type { MarketData } from "../alpaca";
import { toEt, type Session } from "../time";

/** A live price older than this is not used (the trade then enters at the next open). */
export const LIVE_MAX_AGE_MIN = 20;

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Pure: is the regular session open at this ET date and minute (holidays and half days from the calendar)? */
export function sessionOpen(sessions: Session[], date: string, minutes: number): boolean {
  const s = sessions.find((x) => x.date === date);
  return !!s && minutes >= mins(s.open) && minutes < mins(s.close);
}

/** Live prices for these symbols when the market is open now, else null (enter at the next open). */
export async function liveEntry(data: MarketData | null, symbols: string[], now: Date): Promise<Record<string, number> | null> {
  if (!data?.getSnapshots) return null;
  const et = toEt(now);
  const sessions = await data.getCalendar(et.date, et.date).catch(() => [] as Session[]);
  if (!sessionOpen(sessions, et.date, et.minutes)) return null;
  const snaps = await data.getSnapshots([...new Set(symbols)]).catch(() => null);
  if (!snaps) return null;
  const out: Record<string, number> = {};
  for (const s of symbols) {
    const x = snaps[s];
    const fresh = x?.at ? now.getTime() - Date.parse(x.at) < LIVE_MAX_AGE_MIN * 60_000 : false;
    if (x?.price && fresh) out[s] = x.price;
  }
  return out[symbols[0]] ? out : null;
}
