/**
 * Price watch: a big company moving 5% or more on the day is breaking news whatever the source. Stories that break on
 * X, in a short-seller report or a niche outlet (AMD, Nov 19 2026: a Hunterbrook investigation posted on X at 10:32 AM,
 * the stock down 8% minutes later) reach none of the scout's feeds, but the move itself shows up in prices.
 *
 * One snapshot request per 100 of the scout's ~400 large and mid caps, at most once a minute (shared by the News tab,
 * the breaking strip and the phone alerts). A move counts once per stock, day and level (5%, then 10%), and keeps the
 * time it was first seen.
 */
import type { MarketData, NewsItem } from "../alpaca";
import { toEt } from "../time";
import { UNIVERSE } from "@/config/universe";
import * as store from "./store";

/** The scout's large and mid caps: big enough that their news, and their moves, are market news even without a card. */
export const BIG_NAMES = new Set(Object.values(UNIVERSE).flat());

export const PRICE_WATCH = { levels: [5, 10], refreshMs: 60_000 };

export interface BigMove { symbol: string; pct: number; price: number; prevClose: number; date: string; level: number; key: string; firstSeen: string }
interface Snap { price: number; prevClose: number | null; sessionDate?: string | null; at?: string | null }

/** Pure: the big names that have moved past a level today (the highest level each has reached). */
export function bigMoves(snaps: Record<string, Snap>, today: string, levels = PRICE_WATCH.levels): Array<Omit<BigMove, "firstSeen">> {
  const out: Array<Omit<BigMove, "firstSeen">> = [];
  for (const [symbol, s] of Object.entries(snaps)) {
    if (!s.prevClose || !s.price || (s.sessionDate && s.sessionDate !== today)) continue;
    const pct = Math.round((s.price / s.prevClose - 1) * 1000) / 10;
    const level = [...levels].reverse().find((l) => Math.abs(pct) >= l);
    if (!level) continue;
    out.push({ symbol, pct, price: s.price, prevClose: s.prevClose, date: today, level, key: `move:${symbol}:${today}:${level}` });
  }
  return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
}

/** Pure: the most recent headline on the stock in the last 3 hours (the likely reason), if any feed has one. */
export function likelyReason(symbol: string, news: Array<Pick<NewsItem, "ts" | "headline" | "symbols" | "source" | "url">>, now: Date): { headline: string; source: string; url: string } | null {
  const n = news.filter((x) => x.symbols.includes(symbol) && x.source !== "Nasdaq halts" && now.getTime() - Date.parse(x.ts) <= 3 * 3600_000).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  return n ? { headline: n.headline, source: n.source, url: n.url } : null;
}

const memo = { at: 0, moves: [] as BigMove[] };

/** Today's big moves (cached a minute), with the time each was first seen. */
export async function priceWatch(data: MarketData | null, now = new Date()): Promise<BigMove[]> {
  if (!data?.getSnapshots) return [];
  if (Date.now() - memo.at < PRICE_WATCH.refreshMs) return memo.moves;
  const today = toEt(now).date;
  const snaps = await data.getSnapshots([...BIG_NAMES]).catch(() => null);
  if (!snaps) return memo.moves;
  const moves = bigMoves(snaps as Record<string, Snap>, today);
  const seen = (await store.cacheGet<Record<string, string>>("price-watch:first").catch(() => null))?.data ?? {};
  let changed = false;
  for (const m of moves) if (!seen[m.key]) { seen[m.key] = now.toISOString(); changed = true; }
  if (changed) {
    // Keep two days of keys.
    const keep = Object.fromEntries(Object.entries(seen).filter(([, at]) => now.getTime() - Date.parse(at) < 2 * 86400_000));
    await store.cachePut("price-watch:first", keep).catch(() => undefined);
  }
  memo.moves = moves.map((m) => ({ ...m, firstSeen: seen[m.key] ?? now.toISOString() }));
  memo.at = Date.now();
  return memo.moves;
}

/** Pure: a move as a news item for the News tab and the breaking strip. */
export function moveItem(m: BigMove, reason: { headline: string; source: string; url: string } | null): NewsItem {
  const dir = m.pct >= 0 ? "up" : "down";
  return {
    id: Math.abs([...m.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)),
    ts: m.firstSeen,
    headline: `${m.symbol} ${dir} ${Math.abs(m.pct).toFixed(1)}% today${reason ? `: ${reason.headline}` : ", no headline in the scout's feeds yet"}`,
    summary: `${m.symbol} at $${m.price.toFixed(2)} against $${m.prevClose.toFixed(2)} at the last close (past ${m.level}%).${reason ? ` Likely reason (${reason.source}): ${reason.headline}` : " The news may be on X, in a short report or a niche outlet: check the stock's own news."}`,
    symbols: [m.symbol], source: "Scout price watch", url: reason?.url || `/chart?symbol=${m.symbol}`,
  };
}
