/**
 * Home-page widgets: the day's top movers and a Stocktwits table (trending, most active, most watched, most
 * bullish, most bearish) with insider (IT) and Congress (CT) trades flagged, plus a "retail greed" reading:
 * the bullish share of sentiment-tagged Stocktwits messages across the stocks shown.
 * X (Twitter) data needs a paid API, so Stocktwits stands in for retail chatter.
 */
import { UNIVERSE } from "@/config/universe";
import { marketDataFromEnv, type DailyBar, type MarketData } from "../alpaca";
import { getJson } from "../http";
import { ST_HOST, ST_UA, type StMessage, type StTrending } from "../sources/stocktwits";
import { addDays, toEt } from "../time";
import * as store from "../scout/store";

export interface MoverRow { symbol: string; price: number; changePct: number; volume: number | null }
export interface Movers { gainers: MoverRow[]; losers: MoverRow[]; scope: "all US stocks" | "the scout's 390 stocks" }

/** Pure: plain common-stock symbols at $1 or more (drops warrants, units and sub-dollar names). */
export const plainMover = (m: { symbol: string; price: number }) => /^[A-Z]{1,5}$/.test(m.symbol) && m.price >= 1;

/** Pure: movers from daily bars (fallback): last close vs the one before, with the day's volume. */
export function moversFromBars(by: Map<string, DailyBar[]>, n = 10): { gainers: MoverRow[]; losers: MoverRow[] } {
  const rows: MoverRow[] = [];
  for (const [symbol, bars] of by) {
    const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (s.length < 2) continue;
    const a = s[s.length - 2], b = s[s.length - 1];
    if (a.c > 0) rows.push({ symbol, price: b.c, changePct: Math.round((b.c / a.c - 1) * 10000) / 100, volume: b.v });
  }
  return { gainers: rows.slice().sort((x, y) => y.changePct - x.changePct).slice(0, n), losers: rows.slice().sort((x, y) => x.changePct - y.changePct).slice(0, n) };
}

export async function moversPanel(now: Date, data: MarketData | null = marketDataFromEnv()): Promise<Movers> {
  if (data?.getMovers && data.getSnapshots) {
    try {
      const m = await data.getMovers(30);
      // SPAC units, warrants and rights are not stocks: a symbol shaped like one is decided by what the security is called.
      const { commonStocksOnly } = await import("../scout/company-match");
      const stocks = new Set(await commonStocksOnly([...m.gainers, ...m.losers].filter(plainMover).map((x) => x.symbol), data.getAsset ? (sym) => data.getAsset!(sym).then((a) => a?.name ?? null) : null));
      const g = m.gainers.filter((x) => plainMover(x) && stocks.has(x.symbol)).slice(0, 10), l = m.losers.filter((x) => plainMover(x) && stocks.has(x.symbol)).slice(0, 10);
      if (g.length) {
        const snaps = await data.getSnapshots([...g, ...l].map((x) => x.symbol)).catch(() => ({} as Record<string, { volume?: number | null }>));
        const row = (x: { symbol: string; price: number; changePct: number }) => ({ ...x, changePct: Math.round(x.changePct * 100) / 100, volume: snaps[x.symbol]?.volume ?? null });
        return { gainers: g.map(row), losers: l.map(row), scope: "all US stocks" };
      }
    } catch {
      /* fall back to the scout's own universe */
    }
  }
  const today = toEt(now).date;
  const syms = [...new Set(Object.values(UNIVERSE).flat())];
  const bars = await store.loadBars(syms, addDays(today, -7), today);
  const by = new Map<string, DailyBar[]>();
  for (const b of bars) by.set(b.symbol, [...(by.get(b.symbol) ?? []), b as DailyBar]);
  if (!by.size) throw new Error("no movers yet");
  return { ...moversFromBars(by), scope: "the scout's 390 stocks" };
}

// ------------------------------------------------------------------ social

export interface SocialRow { symbol: string; company: string | null; watchers: number | null; rank: number | null; rankChange: number | null; perHour: number | null; posts: number; bullishPct: number | null; bearishPct: number | null; insider: boolean; congress: boolean }
export interface Social { rows: SocialRow[]; retailGreed: number | null; tagged: number; measuredAt: string }

/** Pure: posts, bullish and bearish shares (of all sampled posts) and posts per hour from a stream. */
export function streamStats(messages: StMessage[], now: Date): { posts: number; perHour: number | null; bullish: number; bearish: number } {
  const tags = messages.map((m) => m.entities?.sentiment?.basic);
  const times = messages.map((m) => Date.parse(m.created_at)).filter((t) => !Number.isNaN(t));
  const span = times.length >= 2 ? (now.getTime() - Math.min(...times)) / 3600_000 : null;
  return { posts: messages.length, perHour: span && span > 0 ? Math.round((messages.length / span) * 10) / 10 : null, bullish: tags.filter((t) => t === "Bullish").length, bearish: tags.filter((t) => t === "Bearish").length };
}

/** Pure: 0-100 retail greed from bullish and bearish tags (50 = balanced). */
export const retailGreed = (bullish: number, bearish: number) => (bullish + bearish >= 20 ? Math.round((bullish / (bullish + bearish)) * 100) : null);

export async function socialPanel(now: Date, fetchImpl?: typeof fetch): Promise<Social> {
  const trending = (await getJson<{ symbols?: StTrending[] }>(`${ST_HOST}/trending/symbols/equities.json`, { headers: ST_UA, fetchImpl, cacheMs: 5 * 60000 })).symbols ?? [];
  // US-listed stocks and funds only: Toronto, Korean, crypto and currency symbols have no price, chart or card here.
  const { plainUsSymbol } = await import("../scout/company-match");
  const top = trending.filter((t) => plainUsSymbol(t.symbol, (t as { exchange?: string }).exchange)).slice(0, 20);
  const streams = await Promise.all(top.map((t) => getJson<{ symbol?: { title?: string; watchlist_count?: number }; messages?: StMessage[] }>(`${ST_HOST}/streams/symbol/${encodeURIComponent(t.symbol)}.json`, { headers: ST_UA, fetchImpl, cacheMs: 10 * 60000, minIntervalMs: 300 }).catch(() => null)));
  // Rank change against the list kept about a day ago.
  const prev = await store.cacheGet<{ ranks: Record<string, number> }>("social-ranks").catch(() => null);
  const ranks = Object.fromEntries(top.map((t, i) => [t.symbol, i + 1]));
  if (!prev || Date.now() - Date.parse(prev.updatedAt) > 20 * 3600_000) await store.cachePut("social-ranks", { ranks }).catch(() => undefined);
  const since = addDays(toEt(now).date, -30);
  const [buys, congress] = await Promise.all([store.insiderBuysSince(since).catch(() => []), store.congressTradesSince(since).catch(() => [])]);
  const ins = new Set(buys.map((b) => b.symbol)), con = new Set(congress.map((t) => t.symbol));
  let bull = 0, bear = 0;
  const rows: SocialRow[] = top.map((t, i) => {
    const st = streams[i]?.messages ? streamStats(streams[i]!.messages!, now) : null;
    if (st) { bull += st.bullish; bear += st.bearish; }
    const before = prev?.data.ranks[t.symbol];
    return {
      symbol: t.symbol, company: streams[i]?.symbol?.title ?? t.title ?? null, watchers: streams[i]?.symbol?.watchlist_count ?? t.watchlist_count ?? null, rank: i + 1,
      rankChange: prev && Date.now() - Date.parse(prev.updatedAt) > 2 * 3600_000 ? (before ? before - (i + 1) : null) : null,
      perHour: st?.perHour ?? null, posts: st?.posts ?? 0, bullishPct: st && st.posts ? Math.round((st.bullish / st.posts) * 100) : null, bearishPct: st && st.posts ? Math.round((st.bearish / st.posts) * 100) : null,
      insider: ins.has(t.symbol), congress: con.has(t.symbol),
    };
  });
  return { rows, retailGreed: retailGreed(bull, bear), tagged: bull + bear, measuredAt: now.toISOString() };
}
