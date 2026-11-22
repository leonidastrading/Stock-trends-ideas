/**
 * The latest headlines on a card's stocks, for the card's "Latest news" (it asks again every 2 minutes while open).
 * From the same Alpaca news feed the scout reads; one shared copy per set of stocks for a minute, so many open cards
 * and tabs cost one request.
 */
import { marketDataFromEnv, type MarketData, type NewsItem } from "../alpaca";

export interface CardNewsItem { at: string; headline: string; source: string; url: string; symbols: string[] }

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; items: CardNewsItem[] }>();

/** Pure: newest first, one per headline, only news on or after `since` (when given), at most `max`. */
export function pickNews(items: NewsItem[], since: string | null, max = 12): CardNewsItem[] {
  const from = since && !Number.isNaN(Date.parse(since)) ? Date.parse(since) : 0;
  const seen = new Set<string>();
  return items
    .filter((n) => Date.parse(n.ts) >= from)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .filter((n) => { const k = n.headline.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, max)
    .map((n) => ({ at: n.ts, headline: n.headline, source: n.source, url: n.url, symbols: n.symbols.slice(0, 6) }));
}

/** Headlines on these stocks since `since` (at most the last 30 days), newest first. */
export async function cardNews(symbols: string[], since: string | null, now: Date, data: MarketData | null = marketDataFromEnv()): Promise<CardNewsItem[]> {
  if (!data) return [];
  const key = `${symbols.join(",")}|${(since ?? "").slice(0, 13)}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.items;
  const floor = now.getTime() - 30 * 86400_000;
  const start = new Date(Math.max(floor, since && !Number.isNaN(Date.parse(since)) ? Date.parse(since) - 3 * 86400_000 : now.getTime() - 7 * 86400_000));
  const items = pickNews(await data.getNews(symbols, start, now, 50).catch(() => [] as NewsItem[]), null, 12);
  cache.set(key, { at: now.getTime(), items });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return items;
}
