/** Lateness measured by code: the primary ticker's 30/90-day move from daily bars and mainstream stories in 30 days from the news stream. */
import type { DailyBar, MarketData } from "../alpaca";
import { coverage } from "../sources/news";
import { addDays } from "../time";
import type { MeasuredLateness } from "./card";

/** Pure: percentage move from the last close at or before `from` to the latest close. */
export function moveSince(bars: DailyBar[], from: string): number | null {
  const sorted = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const base = sorted.filter((b) => b.date <= from).pop() ?? sorted[0];
  const last = sorted[sorted.length - 1];
  if (base.date === last.date || base.c <= 0) return null;
  return Math.round((last.c / base.c - 1) * 1000) / 10;
}

export async function measureLateness(data: MarketData | null, symbol: string, now: Date): Promise<MeasuredLateness> {
  const out: MeasuredLateness = { newsStories30d: null, stockMove30dPct: null, stockMove90dPct: null };
  if (!data) return out;
  const today = now.toISOString().slice(0, 10);
  try {
    const bars = await data.getDailyBars([symbol], addDays(today, -100), today);
    out.hasPrices = bars.length > 0;
    out.stockMove30dPct = moveSince(bars, addDays(today, -30));
    out.stockMove90dPct = moveSince(bars, addDays(today, -90));
  } catch {
    /* unmeasured: the gate notes say so */
  }
  try {
    const items = await data.getNews([symbol], new Date(now.getTime() - 30 * 86400000), now, 300);
    out.newsStories30d = coverage(items).mainstream;
  } catch {
    /* unmeasured */
  }
  return out;
}
