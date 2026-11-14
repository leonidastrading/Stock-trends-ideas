/**
 * Stocktwits, through the same public endpoints the Trending Five app uses
 * (no key): the trending list (rank, trending score, watchers) and each
 * symbol's public message stream, from which the message rate per hour and
 * the bullish share are measured. The 12-month base for every metric comes
 * from the scout's own stored history once it has one.
 */
import { getJson } from "../http";
import { dateStr, guarded, r1, type Signal, type Source } from "./types";

export const ST_UA = { "user-agent": "Mozilla/5.0 (trend-scout)", accept: "application/json" };
const UA = ST_UA;
export const ST_HOST = "https://api.stocktwits.com/api/2";
const HOST = ST_HOST;
const MAX_TICKERS = 3;

export interface StMessage { id: number; created_at: string; entities?: { sentiment?: { basic?: string } | null } }
export interface StTrending { symbol: string; title?: string; trending_score?: number; watchlist_count?: number; trends?: { summary?: string } | null }
interface Stream { symbol?: { symbol: string; title?: string; watchlist_count?: number }; messages?: StMessage[] }

/** Pure: messages per hour over the span of the latest messages, and the bullish share of those that carry a sentiment tag. */
export function messageRate(messages: StMessage[], now: Date): { perHour: number; bullishShare: number | null; spanHours: number } | null {
  const times = messages.map((m) => Date.parse(m.created_at)).filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  const oldest = Math.min(...times);
  const spanHours = Math.max((now.getTime() - oldest) / 3600000, 1 / 60);
  const tagged = messages.map((m) => m.entities?.sentiment?.basic).filter((s): s is string => !!s);
  const bullish = tagged.filter((s) => s === "Bullish").length;
  return { perHour: r1(times.length / spanHours), bullishShare: tagged.length ? Math.round((bullish / tagged.length) * 100) / 100 : null, spanHours: r1(spanHours) };
}

/** Pure: a ticker's 1-based rank in the trending list, if present. */
export function trendingEntry(list: StTrending[], symbol: string): { rank: number; score: number | null; watchers: number | null; summary: string | null } | null {
  const i = list.findIndex((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
  if (i < 0) return null;
  const s = list[i];
  return { rank: i + 1, score: s.trending_score ?? null, watchers: s.watchlist_count ?? null, summary: s.trends?.summary?.trim() || null };
}

export const stocktwits: Source = {
  id: "stocktwits",
  label: "Stocktwits",
  about: "Message rate per hour and bullish share from each ticker's public stream; trending rank, score and watchers from the trending list (lower rank is better).",
  configured: () => true,
  probe: (ctx) =>
    guarded("stocktwits", async () => {
      if (!ctx.tickers.length) return { source: "stocktwits", status: "ok", detail: "no tickers to look up yet", signals: [] };
      const today = dateStr(ctx.now);
      const trending = await getJson<{ symbols?: StTrending[] }>(`${HOST}/trending/symbols/equities.json`, { headers: UA, minIntervalMs: 1500, fetchImpl: ctx.fetchImpl, cacheMs: 30 * 60000 }).then((r) => r.symbols ?? []).catch(() => [] as StTrending[]);
      const signals: Signal[] = [];
      let failures = 0;
      for (const symbol of ctx.tickers.slice(0, MAX_TICKERS)) {
        let stream: Stream;
        try {
          stream = await getJson<Stream>(`${HOST}/streams/symbol/${encodeURIComponent(symbol)}.json?limit=30`, { headers: UA, minIntervalMs: 1500, fetchImpl: ctx.fetchImpl, cacheMs: 30 * 60000 });
        } catch (err) {
          failures++;
          if (/ 429/.test(err instanceof Error ? err.message : "")) throw err;
          continue;
        }
        const rate = messageRate(stream.messages ?? [], ctx.now);
        const t = trendingEntry(trending, symbol);
        const watchers = stream.symbol?.watchlist_count ?? t?.watchers ?? null;
        if (rate) {
          signals.push({
            source: "stocktwits", metric: `messages_per_hour:${symbol}`, value: rate.perHour, baseline: null, changeVs12m: null, asOf: today,
            note: `${symbol}: ${rate.perHour} Stocktwits messages/hour over the latest ${(stream.messages ?? []).length} (${rate.spanHours}h span)${rate.bullishShare === null ? "" : `, ${Math.round(rate.bullishShare * 100)}% of tagged messages bullish`}${t ? `; #${t.rank} on the trending list` : "; not on the trending list"} (12-month base from stored history)`,
            detail: { bullish_share: rate.bullishShare, span_hours: rate.spanHours, watchers, trending_rank: t?.rank ?? null, trending_score: t?.score ?? null, why_trending: t?.summary ?? null },
          });
        }
        if (watchers !== null) signals.push({ source: "stocktwits", metric: `watchers:${symbol}`, value: watchers, baseline: null, changeVs12m: null, asOf: today, note: `${symbol}: ${watchers.toLocaleString("en-US")} Stocktwits watchers (12-month base from stored history)` });
        if (t) signals.push({ source: "stocktwits", metric: `trending_rank:${symbol}`, value: t.rank, baseline: null, changeVs12m: null, asOf: today, note: `${symbol}: #${t.rank} on Stocktwits' trending list${t.score !== null ? `, score ${t.score}` : ""}${t.summary ? ` — ${t.summary.slice(0, 200)}` : ""}`, detail: { lower_is_better: true } });
      }
      if (failures && !signals.length) return { source: "stocktwits", status: "down", detail: `symbol stream unavailable for ${ctx.tickers.slice(0, MAX_TICKERS).join(", ")}`, signals: [] };
      return { source: "stocktwits", status: failures ? "capped" : "ok", detail: failures ? `${failures} ticker stream(s) unavailable` : undefined, signals };
    }),
};
