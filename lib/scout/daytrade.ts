/**
 * Daytrade: Stocktwits' trending ten, read every five minutes and kept, so the tab can show the list as it stands,
 * how each name moved up or down it, when it joined today and what the stock has done since. No AI, no cards.
 */
import type { MarketData } from "../alpaca";
import { query as q } from "../db";
import { getJson } from "../http";
import { ST_HOST, ST_UA, type StTrending } from "../sources/stocktwits";
import { toEt } from "../time";
import * as store from "./store";

export const DAYTRADE = { size: 10, everyMin: 5, keepDays: 14 };

export interface DtItem { rank: number; symbol: string; name: string | null; exchange: string | null; watchers: number | null; score: number | null; summary: string | null; price: number | null; prevClose: number | null }
export interface DtSnap { id: number; takenAt: string; items: DtItem[] }
/** A name on the list now, with its history today. `rankBefore` is its place in the reading before this one (null: it was not on it). */
export interface DtRow extends DtItem { rankBefore: number | null; firstSeen: string; firstPrice: number | null; bestRank: number; reads: number }
/** A name that was on today's list and is not on it now. */
export interface DtGone { symbol: string; name: string | null; exchange: string | null; firstSeen: string; lastSeen: string; firstPrice: number | null; bestRank: number; reads: number }
export interface DtBoard { latest: DtSnap | null; readsToday: number; rows: DtRow[]; gone: DtGone[] }

/** Pure: the board from the kept readings: the latest list, and for each name its history on the latest reading's New York day. */
export function daytradeBoard(snaps: DtSnap[]): DtBoard {
  const sorted = [...snaps].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const latest = sorted[sorted.length - 1] ?? null;
  if (!latest) return { latest: null, readsToday: 0, rows: [], gone: [] };
  const day = toEt(new Date(latest.takenAt)).date;
  const today = sorted.filter((s) => toEt(new Date(s.takenAt)).date === day);
  const before = sorted[sorted.length - 2] ?? null;
  const seen = new Map<string, { first: DtSnap; firstItem: DtItem; last: DtSnap; lastItem: DtItem; best: number; reads: number; firstPrice: number | null }>();
  for (const s of today) for (const i of s.items) {
    const h = seen.get(i.symbol);
    if (!h) seen.set(i.symbol, { first: s, firstItem: i, last: s, lastItem: i, best: i.rank, reads: 1, firstPrice: i.price });
    // The first reading may have had no price (before the first trade of the day): the first one with a price stands in.
    else { h.last = s; h.lastItem = i; h.best = Math.min(h.best, i.rank); h.reads++; h.firstPrice ??= i.price; }
  }
  const rows = latest.items.map((i) => {
    const h = seen.get(i.symbol)!;
    return { ...i, rankBefore: before?.items.find((x) => x.symbol === i.symbol)?.rank ?? null, firstSeen: h.first.takenAt, firstPrice: h.firstPrice, bestRank: h.best, reads: h.reads };
  });
  const on = new Set(latest.items.map((i) => i.symbol));
  const gone = [...seen].filter(([sym]) => !on.has(sym)).map(([symbol, h]) => ({ symbol, name: h.lastItem.name, exchange: h.lastItem.exchange, firstSeen: h.first.takenAt, lastSeen: h.last.takenAt, firstPrice: h.firstPrice, bestRank: h.best, reads: h.reads }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.bestRank - b.bestRank);
  return { latest, readsToday: today.length, rows, gone };
}

/** Pure: how a name moved since the reading before ("new", "▲2", "▼1", "" when unchanged or there is no reading before). */
export function rankMove(rank: number, rankBefore: number | null, hasBefore: boolean): { text: string; dir: "up" | "down" | "new" | "same" } {
  if (!hasBefore) return { text: "", dir: "same" };
  if (rankBefore === null) return { text: "new", dir: "new" };
  const d = rankBefore - rank;
  return d > 0 ? { text: `▲${d}`, dir: "up" } : d < 0 ? { text: `▼${-d}`, dir: "down" } : { text: "", dir: "same" };
}

const toSnap = (r: Record<string, unknown>): DtSnap => ({ id: Number(r.id), takenAt: new Date(r.taken_at as string).toISOString(), items: (r.items as DtItem[]) ?? [] });

/** The readings of the last `hours` hours, oldest first. */
export async function daytradeSnaps(hours = 30): Promise<DtSnap[]> {
  return (await q(`SELECT id, taken_at, items FROM daytrade_snaps WHERE taken_at > now() - make_interval(hours => $1) ORDER BY taken_at`, [hours])).map(toSnap);
}

/** Read the trending ten and keep it, unless a reading was kept in the last three minutes. */
export async function runDaytrade(deps: { data: MarketData | null; fetchImpl?: typeof fetch }): Promise<string> {
  if (!(await store.tryLock("lock:daytrade:read", 3))) return "daytrade: read in the last 3 minutes";
  const trending = ((await getJson<{ symbols?: Array<StTrending & { exchange?: string }> }>(`${ST_HOST}/trending/symbols/equities.json`, { headers: ST_UA, fetchImpl: deps.fetchImpl, cacheMs: 0 })).symbols ?? []).slice(0, DAYTRADE.size);
  if (!trending.length) return "daytrade failed: Stocktwits' trending list came back empty";
  const snaps = (deps.data?.getSnapshots ? await deps.data.getSnapshots(trending.map((t) => t.symbol)).catch(() => ({})) : {}) as Record<string, { price: number; prevClose: number | null }>;
  const items: DtItem[] = trending.map((t, i) => ({
    rank: i + 1, symbol: t.symbol, name: t.title ?? null, exchange: t.exchange ?? null, watchers: t.watchlist_count ?? null, score: t.trending_score ?? null,
    summary: t.trends?.summary?.trim() || null, price: snaps[t.symbol]?.price ?? null, prevClose: snaps[t.symbol]?.prevClose ?? null,
  }));
  await q(`INSERT INTO daytrade_snaps (items) VALUES ($1)`, [JSON.stringify(items)]);
  await q(`DELETE FROM daytrade_snaps WHERE taken_at < now() - make_interval(days => $1)`, [DAYTRADE.keepDays]);
  return `daytrade: ${items.map((i) => i.symbol).join(", ")}`;
}
