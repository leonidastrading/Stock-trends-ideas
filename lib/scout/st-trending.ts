/**
 * Stocktwits' trending ten, kept twice a day (9 AM and 3 PM New York time, every day): each ticker with its name,
 * exchange, sector, watchers, why it is trending (Stocktwits' own summary), the price then and its latest headlines,
 * plus the market's top headlines at that moment. Each snapshot is kept, so the tab can show how the list's stocks
 * did after they trended. No AI.
 */
import type { MarketData, NewsItem } from "../alpaca";
import { query as q } from "../db";
import { getJson } from "../http";
import { ST_HOST, ST_UA, type StTrending } from "../sources/stocktwits";
import { toEt } from "../time";

export const ST_SLOTS = [{ key: "am", label: "9 AM", minutes: 9 * 60 }, { key: "pm", label: "3 PM", minutes: 15 * 60 }] as const;
export type Slot = (typeof ST_SLOTS)[number]["key"];

export interface StItem { rank: number; symbol: string; name: string | null; exchange: string | null; sector: string | null; watchers: number | null; summary: string | null; price: number | null; headlines: Array<{ headline: string; url: string; source: string; at: string }> }
export interface StSnapshot { id: number; date: string; slot: Slot; takenAt: string; market: Array<{ headline: string; url: string; source: string; at: string }>; items: StItem[] }

/** Pure: the slot to take now: the latest one whose time has come today and is not taken yet (a late first run takes only the later slot). */
export function dueSlot(minutes: number, taken: Set<string>): Slot | null {
  const ready = ST_SLOTS.filter((s) => minutes >= s.minutes);
  const last = ready[ready.length - 1];
  return last && !taken.has(last.key) ? last.key : null;
}

const toSnap = (r: Record<string, unknown>): StSnapshot => ({
  id: Number(r.id), date: r.et_date instanceof Date ? r.et_date.toISOString().slice(0, 10) : String(r.et_date).slice(0, 10), slot: r.slot as Slot, takenAt: new Date(r.taken_at as string).toISOString(),
  market: (r.market as StSnapshot["market"]) ?? [], items: (r.items as StItem[]) ?? [],
});

export async function stSnapshots(limit = 30): Promise<StSnapshot[]> {
  return (await q(`SELECT * FROM st_snapshots ORDER BY taken_at DESC LIMIT $1`, [limit])).map(toSnap);
}

/** Take the slot's snapshot if it is due. */
export async function runStTrending(deps: { data: MarketData | null; now: Date; fetchImpl?: typeof fetch }): Promise<string> {
  const et = toEt(deps.now);
  const taken = new Set((await q(`SELECT slot FROM st_snapshots WHERE et_date = $1`, [et.date])).map((r) => String(r.slot)));
  const slot = dueSlot(et.minutes, taken);
  if (!slot) return "stocktwits: nothing due";
  const trending = ((await getJson<{ symbols?: Array<StTrending & { exchange?: string; sector?: string }> }>(`${ST_HOST}/trending/symbols/equities.json`, { headers: ST_UA, fetchImpl: deps.fetchImpl, cacheMs: 0 })).symbols ?? []).slice(0, 10);
  if (!trending.length) return "stocktwits: trending list empty";
  const syms = trending.map((t) => t.symbol);
  const snaps = (deps.data?.getSnapshots ? await deps.data.getSnapshots(syms).catch(() => ({})) : {}) as Record<string, { price: number }>;
  const items: StItem[] = [];
  for (const [i, t] of trending.entries()) {
    const s = await getJson<{ symbol?: { title?: string; exchange?: string; sector?: string; industry?: string; watchlist_count?: number } }>(`${ST_HOST}/streams/symbol/${encodeURIComponent(t.symbol)}.json?limit=1`, { headers: ST_UA, fetchImpl: deps.fetchImpl, cacheMs: 30 * 60000, minIntervalMs: 400 }).catch(() => null);
    const news = deps.data ? await deps.data.getNews([t.symbol], new Date(deps.now.getTime() - 4 * 86400_000), deps.now, 10).catch(() => [] as NewsItem[]) : [];
    items.push({
      rank: i + 1, symbol: t.symbol, name: s?.symbol?.title ?? t.title ?? null, exchange: s?.symbol?.exchange ?? t.exchange ?? null, sector: s?.symbol?.sector ?? t.sector ?? null,
      watchers: s?.symbol?.watchlist_count ?? t.watchlist_count ?? null, summary: t.trends?.summary?.trim() || null, price: snaps[t.symbol]?.price ?? null,
      headlines: news.filter((n) => n.symbols.length <= 4).slice(0, 3).map((n) => ({ headline: n.headline, url: n.url, source: n.source, at: n.ts })),
    });
  }
  const { googleNews } = await import("./rumor-check");
  const market = (await googleNews("stock market today futures", deps.fetchImpl).catch(() => [])).filter((x) => Date.parse(x.at) > deps.now.getTime() - 18 * 3600_000).slice(0, 3);
  await q(`INSERT INTO st_snapshots (et_date, slot, market, items) VALUES ($1, $2, $3, $4) ON CONFLICT (et_date, slot) DO NOTHING`, [et.date, slot, JSON.stringify(market), JSON.stringify(items)]);
  return `stocktwits: ${slot} snapshot of ${items.length} (${syms.join(", ")})`;
}
