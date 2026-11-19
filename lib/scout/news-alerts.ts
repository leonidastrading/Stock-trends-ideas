/**
 * Phone alerts for breaking news on your stocks, when the dashboard is not open: meant to be called every minute by
 * an outside scheduler. Reads the fast sources (Nasdaq halts, SEC 8-Ks, press wires, Finnhub) and Alpaca's last
 * minutes, and pushes:
 * - on your stocks (a card in the last 30 days or the watch-list): halts (not routine volatility pauses), 8-Ks, press
 *   releases, and headlines with an event word;
 * - on any big company (the scout's ~400 large and mid caps) or any stock several outlets are reporting at once: a
 *   headline with an event word that at least two sources carry ("big story");
 * - any big company moving 5% or more on the day (and again at 10%), with the likely headline if a feed has one: stories
 *   that break on X or in a short report reach no feed, but the move does (price watch).
 * Each story is alerted once: one push per stock per run, and a big story on a stock at most once every two hours.
 */
import type { MarketData, NewsItem } from "../alpaca";
import { fastNews } from "../sources/wires";
import { eventWord } from "./stories";
import { isRoutinePause, NEWS_EVENT } from "./newsfeed";
import { BIG_NAMES, confirmed, moveTitle, priceWatch, reasonFor } from "./price-watch";
import { toEt } from "../time";

export { BIG_NAMES };
import * as store from "./store";

export const ALERTS = { lookbackMin: 20, maxPerRun: 5, keep: 600, bigStorySources: 2, crowdSources: 3, bigStoryCooldownH: 2 };

/** Pure: which new items deserve an alert, most urgent first. */
export function pickAlerts(items: NewsItem[], mine: Set<string>, sent: Set<string>, now: Date, lookbackMin = ALERTS.lookbackMin, big: Set<string> = BIG_NAMES): Array<NewsItem & { why: string; key: string; symbol: string; bigStory: boolean; cooldown: boolean }> {
  const fresh = items.filter((n) => !n.repostedAt && now.getTime() - Date.parse(n.ts) <= lookbackMin * 60_000 && n.symbols.length <= 4 && !isRoutinePause({ source: n.source, headline: n.headline, summary: n.summary ?? "" }));
  // How many different outlets carry each stock right now (a story everyone is running is a big story).
  const sourcesBy = new Map<string, Set<string>>();
  for (const n of fresh) for (const s of n.symbols) sourcesBy.set(s, (sourcesBy.get(s) ?? new Set()).add(n.source));
  const hour = Math.floor(now.getTime() / (ALERTS.bigStoryCooldownH * 3600_000));
  const out: Array<NewsItem & { why: string; key: string; symbol: string; bigStory: boolean; cooldown: boolean }> = [];
  for (const n of fresh) {
    const key = `${n.source}:${n.url}:${n.headline}`.slice(0, 300);
    if (sent.has(key)) continue;
    const event = eventWord(n.headline) ?? (NEWS_EVENT.exec(n.headline)?.[1]?.toLowerCase() ?? null);
    const hit = n.symbols.find((s) => mine.has(s));
    if (hit) {
      const why = n.source === "Nasdaq halts" ? "halt" : n.source === "SEC 8-K" ? "filing" : ["GlobeNewswire", "PR Newswire"].includes(n.source) ? "press release" : event;
      // A headline story (not a halt, filing or press release) on the same stock alerts once per cooldown.
      const story = why === event;
      if (why && !(story && sent.has(`story:${hit}:${hour}`))) out.push({ ...n, why, key, symbol: hit, bigStory: false, cooldown: story });
      continue;
    }
    // Not on your cards: only a big story (an event word, carried by several outlets) on a big name, or one everyone is running.
    if (!event || n.source === "Nasdaq halts" || n.source === "SEC 8-K") continue;
    const sym = n.symbols.find((s) => (sourcesBy.get(s)?.size ?? 0) >= (big.has(s) ? ALERTS.bigStorySources : ALERTS.crowdSources));
    if (!sym || sent.has(`story:${sym}:${hour}`)) continue;
    out.push({ ...n, why: event, key, symbol: sym, bigStory: true, cooldown: true });
  }
  const rank = (a: { why: string; bigStory: boolean }) => (a.why === "halt" ? 0 : a.why === "filing" ? 1 : a.bigStory ? 3 : a.why === "press release" ? 2 : 2.5);
  // One push per stock per run: the most urgent item.
  const seen = new Set<string>();
  return out.sort((a, b) => rank(a) - rank(b) || b.ts.localeCompare(a.ts)).filter((a) => (seen.has(a.symbol) ? false : (seen.add(a.symbol), true)));
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
    const sym = p.symbol;
    const card = cardBy.get(sym);
    await sendPush({ title: `${p.why === "halt" ? "⛔ HALT" : p.why === "filing" ? "📄 8-K" : p.bigStory ? "🔥" : "📰"} ${sym}${card ? ` · card #${card}` : p.bigStory ? ` · big story (${p.why})` : ""}`, message: `${p.headline}\n${p.source} · ${new Date(p.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`, click: p.url.startsWith("http") ? p.url : `${base}/news`, tags: [p.why === "halt" ? "no_entry" : "newspaper"], priority: p.why === "halt" || p.why === "filing" ? 5 : 4 }, env).catch(() => undefined);
  }
  // Price watch: big moves on big companies, from 4 AM to 8 PM ET on weekdays (up to 3 a run, biggest first).
  const et = toEt(deps.now);
  const weekday = ![0, 6].includes(new Date(`${et.date}T12:00:00Z`).getUTCDay());
  const moves = weekday && et.minutes >= 4 * 60 && et.minutes < 20 * 60 ? (await priceWatch(deps.data, deps.now).catch(() => [])).filter((m) => !sentKeys.includes(m.key) && confirmed(m, deps.now)).slice(0, 3) : [];
  for (const m of moves) {
    const reason = await reasonFor(m, [...fast, ...alpaca], deps.now).catch(() => null);
    const card = cardBy.get(m.symbol);
    await sendPush({ title: `${m.pct < 0 ? "📉" : "📈"} ${moveTitle(m)}${card ? ` · card #${card}` : ""}`, message: `${reason ? `${reason.headline}\n${reason.source}` : "No headline in the scout's feeds yet: the news may be on X, in a short report or a niche outlet."}\n$${m.price.toFixed(2)} vs $${m.prevClose.toFixed(2)} at ${m.vs}`, click: reason?.url?.startsWith("http") ? reason.url : `${base}/chart?symbol=${m.symbol}`, tags: [m.pct < 0 ? "chart_with_downwards_trend" : "chart_with_upwards_trend"], priority: m.level >= 10 || card ? 5 : 4 }, env).catch(() => undefined);
  }
  // Every item of each story pushed counts as sent (so the other outlets' copies do not push again), plus the story itself.
  const hour = Math.floor(deps.now.getTime() / (ALERTS.bigStoryCooldownH * 3600_000));
  // A move also covers its lower level (a stock first seen at -11% does not push again for 5%).
  const done = [...picks.flatMap((p) => [p.key, ...(p.cooldown ? [`story:${p.symbol}:${hour}`] : [])]), ...moves.flatMap((m) => [m.key, ...[5, 10].filter((l) => l < m.level).map((l) => `move:${m.symbol}:${m.date}:${m.phase}:${l}`)])];
  if (done.length) await store.cachePut("news-alerts:sent", { keys: [...done, ...sentKeys].slice(0, ALERTS.keep) }).catch(() => undefined);
  return `${picks.length + moves.length} alert${picks.length + moves.length === 1 ? "" : "s"} sent${moves.length ? ` (${moves.length} big moves)` : ""} (${fast.length + alpaca.length} items checked, ${mine.size} of your stocks)`;
}
