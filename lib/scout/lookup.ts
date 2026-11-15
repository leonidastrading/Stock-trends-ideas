/** Home-page ticker search: the scout's cards on a stock and what else it has seen about it. Stored data and caches only. */
import { addDays, toEt } from "../time";
import { newsFeed } from "./newsfeed";
import * as store from "./store";

export interface Lookup {
  symbol: string; name: string | null; nextEarnings: string | null;
  cards: Array<{ id: number; createdAt: string; title: string; direction: string; status: string; confidence: number; primary: boolean }>;
  insider: string[]; congress: string[]; options: string[]; truth: string[]; news: Array<{ at: string; headline: string; url: string }>;
}

/** Pure: a typed ticker, cleaned ($nvda → NVDA); null if it cannot be a ticker. */
export function cleanSymbol(raw: string): string | null {
  const s = raw.trim().replace(/^\$/, "").toUpperCase().replace(/-/g, ".");
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(s) ? s : null;
}

const usd = (v: number | null) => (v === null ? "?" : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

export async function lookupTicker(symbol: string, now = new Date()): Promise<Lookup> {
  const today = toEt(now).date;
  const since = addDays(today, -90);
  const [cards, info, buys, congress, flags, posts, news] = await Promise.all([
    store.cardsForSymbol(symbol), store.symbolInfo([symbol]).then((m) => m.get(symbol) ?? null).catch(() => null),
    store.insiderBuysSince(since).catch(() => []), store.congressTradesSince(since).catch(() => []), store.optionsFlagsSince(addDays(today, -30)).catch(() => []),
    store.truthPostsSince(new Date(now.getTime() - 14 * 86400_000).toISOString(), true).catch(() => []), newsFeed(now).catch(() => []),
  ]);
  return {
    symbol, name: info?.name ?? null, nextEarnings: info?.nextEarnings ?? null,
    cards: cards.map((c) => ({ id: c.id, createdAt: c.createdAt, title: c.title, direction: c.direction, status: c.status, confidence: c.card.confidence, primary: c.primaryTicker === symbol })),
    insider: buys.filter((b) => b.symbol === symbol).map((b) => `${b.filed}: ${b.owner ?? "insider"} (${b.role ?? "?"}) bought ${usd(b.value)}${b.routine === false ? ", opportunistic" : ""}`),
    congress: congress.filter((t) => t.symbol === symbol).map((t) => `${t.filed}: ${t.member} (${t.chamber}) ${t.tx} ${t.amount}, traded ${t.txDate}`),
    options: flags.filter((f) => f.symbol === symbol).map((f) => `${f.date}: +${(f.oi - f.prevOi).toLocaleString("en-US")} ${f.expiry} $${f.strike} ${f.type}s${f.structure ? `; ${f.structure}` : ""}`),
    truth: posts.filter((p) => p.read?.tickers.includes(symbol)).map((p) => `${p.at.slice(0, 10)}: ${p.read!.summary}`),
    news: news.filter((n) => n.symbols.includes(symbol)).slice(0, 6).map((n) => ({ at: n.at, headline: n.headline, url: n.url })),
  };
}
