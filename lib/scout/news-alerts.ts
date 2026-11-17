/**
 * Phone alerts for breaking news on your stocks, when the dashboard is not open: meant to be called every minute by
 * an outside scheduler. Reads the fast sources (Nasdaq halts, SEC 8-Ks, press wires, Finnhub) and Alpaca's last
 * minutes, and pushes anything new on a stock with a card in the last 30 days or on the watch-list: every halt and
 * filing, and headlines with an event word. Each item is alerted once.
 */
import type { MarketData, NewsItem } from "../alpaca";
import { fastNews } from "../sources/wires";
import { eventWord } from "./stories";
import { NEWS_EVENT } from "./newsfeed";
import * as store from "./store";

export const ALERTS = { lookbackMin: 20, maxPerRun: 5, keep: 600 };

/** Pure: which new items deserve an alert, most urgent first. */
export function pickAlerts(items: NewsItem[], mine: Set<string>, sent: Set<string>, now: Date, lookbackMin = ALERTS.lookbackMin): Array<NewsItem & { why: string; key: string }> {
  const out: Array<NewsItem & { why: string; key: string }> = [];
  for (const n of items) {
    if (n.repostedAt || now.getTime() - Date.parse(n.ts) > lookbackMin * 60_000) continue;
    const hit = n.symbols.find((s) => mine.has(s));
    if (!hit || n.symbols.length > 4) continue;
    const key = `${n.source}:${n.url}:${n.headline}`.slice(0, 300);
    if (sent.has(key)) continue;
    const why = n.source === "Nasdaq halts" ? "halt" : n.source === "SEC 8-K" ? "filing" : ["GlobeNewswire", "PR Newswire"].includes(n.source) ? "press release" : eventWord(n.headline) ?? (NEWS_EVENT.exec(n.headline)?.[1]?.toLowerCase() ?? null);
    if (!why) continue;
    out.push({ ...n, why, key });
  }
  const rank = (w: string) => (w === "halt" ? 0 : w === "filing" ? 1 : w === "press release" ? 2 : 3);
  return out.sort((a, b) => rank(a.why) - rank(b.why) || b.ts.localeCompare(a.ts));
}

/** One pass: alert new items on your stocks. Returns a summary. */
export async function runNewsAlerts(deps: { data: MarketData | null; now: Date; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<string> {
  const env = deps.env ?? process.env;
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured(env)) return "skipped: phone alerts are not set up (NTFY_TOPIC)";
  const since = new Date(deps.now.getTime() - ALERTS.lookbackMin * 60_000);
  const [fast, alpaca, cards, watch, sentDoc] = await Promise.all([
    fastNews(env, deps.fetchImpl, deps.now),
    deps.data ? deps.data.getNews([], since, deps.now, 100).catch(() => [] as NewsItem[]) : Promise.resolve([] as NewsItem[]),
    store.cardsSince(30).catch(() => []),
    store.watchlist("active").catch(() => []),
    store.cacheGet<{ keys: string[] }>("news-alerts:sent").catch(() => null),
  ]);
  const mine = new Set([...cards.flatMap((c) => c.card.tickers.map((t) => t.symbol)), ...watch.flatMap((w) => w.tickers)]);
  const sentKeys = sentDoc?.data.keys ?? [];
  const picks = pickAlerts([...fast, ...alpaca], mine, new Set(sentKeys), deps.now).slice(0, ALERTS.maxPerRun);
  const base = (env.DASHBOARD_URL ?? "").replace(/\/$/, "");
  const cardBy = new Map<string, number>();
  for (const c of cards) for (const t of c.card.tickers) if (!cardBy.has(t.symbol) || c.id > cardBy.get(t.symbol)!) cardBy.set(t.symbol, c.id);
  for (const p of picks) {
    const sym = p.symbols.find((s) => mine.has(s))!;
    const card = cardBy.get(sym);
    await sendPush({ title: `${p.why === "halt" ? "⛔ HALT" : p.why === "filing" ? "📄 8-K" : "📰"} ${sym}${card ? ` · card #${card}` : ""}`, message: `${p.headline}\n${p.source} · ${new Date(p.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`, click: p.url.startsWith("http") ? p.url : `${base}/news`, tags: [p.why === "halt" ? "no_entry" : "newspaper"], priority: p.why === "halt" || p.why === "filing" ? 5 : 4 }, env).catch(() => undefined);
  }
  if (picks.length) await store.cachePut("news-alerts:sent", { keys: [...picks.map((p) => p.key), ...sentKeys].slice(0, ALERTS.keep) }).catch(() => undefined);
  return `${picks.length} alert${picks.length === 1 ? "" : "s"} sent (${fast.length + alpaca.length} items checked, ${mine.size} of your stocks)`;
}
