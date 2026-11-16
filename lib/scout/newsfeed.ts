/**
 * News tab: the last day's headlines from Alpaca's news stream (Benzinga) plus Trump posts judged
 * market-relevant, ranked for "top" by freshness, event words, how many headlines pile onto the same
 * stock, and whether the stock is on one of the scout's cards. The page polls for new items.
 */
import { marketDataFromEnv, type NewsItem } from "../alpaca";
import { eventWord } from "./stories";
import * as store from "./store";

/** Extra event words for the News tab only (operational shocks the story desk's list does not name). */
const NEWS_EVENT = /\b(ground stop|grounded|grounding|delist\w*|cyberattack|ransomware|explosion|evacuat\w*|derail\w*|shutdown|layoffs?|job cuts|guidance raise|raises guidance|misses estimates|beats estimates)\b/i;

export interface FeedItem { id: string; at: string; headline: string; summary: string; source: string; url: string; symbols: string[]; event: string | null; cardIds: number[]; buzz: number; score: number; kind: "news" | "trump" | "rumor"; repostedAt?: string }

/** Pure: score and rank. Freshness halves every 6 hours; an event word, a pile-up on one stock and a card on it each lift a story. */
export function rankFeed(items: Array<Omit<FeedItem, "score" | "buzz" | "event" | "cardIds">>, cards: Map<string, number[]>, now: Date): FeedItem[] {
  const recentBySym = new Map<string, number>();
  for (const i of items) if (now.getTime() - Date.parse(i.at) < 6 * 3600_000) for (const s of i.symbols) recentBySym.set(s, (recentBySym.get(s) ?? 0) + 1);
  return items.map((i) => {
    const ageH = Math.max(0, (now.getTime() - Date.parse(i.at)) / 3600_000);
    // "strike price" and similar options wording is not a strike; the story desk's own word list is left as it is.
    const text = `${i.headline} ${i.summary}`.replace(/\bstrike(?: prices?| of)\b/gi, "");
    const event = eventWord(text) ?? (NEWS_EVENT.exec(text)?.[1]?.toLowerCase() ?? null);
    const cardIds = [...new Set(i.symbols.flatMap((s) => cards.get(s) ?? []))];
    const buzz = Math.max(0, ...i.symbols.map((s) => recentBySym.get(s) ?? 0));
    const broad = i.symbols.length > 4; // round-ups tagged with many tickers are rarely the story
    const weight = 1 + (event ? 1.5 : 0) + Math.min(2, Math.max(0, buzz - 1) * 0.5) + (cardIds.length ? (event || buzz >= 2 ? 1.5 : 0.5) : 0) + (i.kind === "trump" ? 1.5 : 0) - (broad ? 1 : 0);
    return { ...i, event, cardIds, buzz, score: Math.round(weight * Math.pow(0.5, ageH / 6) * 100) / 100 };
  });
}

const cache = { at: 0, items: [] as FeedItem[] };

/** The last 24 hours, newest data at most 30 seconds old. */
export async function newsFeed(now = new Date()): Promise<FeedItem[]> {
  if (Date.now() - cache.at < 30_000 && cache.items.length) return cache.items;
  const data = marketDataFromEnv();
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [news, posts, cards, fromRumors] = await Promise.all([
    data ? data.getNews([], since, now, 200).catch(() => [] as NewsItem[]) : Promise.resolve([] as NewsItem[]),
    store.truthPostsSince(since.toISOString(), true).catch(() => []),
    store.cardsSince(30).catch(() => []),
    import("./rumor-check").then(({ alreadyNewsSince }) => alreadyNewsSince(new Date(now.getTime() - 3 * 86400_000))).catch(() => []),
  ]);
  const bare = (h: string) => h.replace(/^\s*reported\s+\w+(\s+week)?\s*,\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const originals = new Set(news.filter((n) => !n.repostedAt).map((n) => bare(n.headline)));
  const bySym = new Map<string, number[]>();
  for (const c of cards) for (const t of c.card.tickers) bySym.set(t.symbol, [...(bySym.get(t.symbol) ?? []), c.id]);
  const items = [
    // A re-post ("Reported Sunday, …") is dropped when the original is in the feed; otherwise shown at the news's own date.
    ...news.filter((n) => !n.repostedAt || !originals.has(bare(n.headline))).map((n) => ({ id: `n${n.id}`, at: n.ts, headline: n.headline, summary: n.summary, source: n.source || "news", url: n.url, symbols: n.symbols.slice(0, 8), kind: "news" as const, ...(n.repostedAt ? { repostedAt: n.repostedAt } : {}) })),
    // Claims from the rumor sources that turned out to be news already: the outlet's headline, flagged as found there.
    ...fromRumors.map(({ rumor, check }) => ({ id: `r${rumor.id}`, at: check.checkedAt, headline: check.evidence[0]?.headline ?? rumor.claim, summary: `Found in ${rumor.source || rumor.docSource}: ${rumor.claim}${check.note ? ` (${check.note})` : ""}`, source: check.evidence[0]?.source ?? "news", url: check.evidence[0]?.url ?? "/rumors?truth=already_news", symbols: rumor.tickers.slice(0, 8), kind: "rumor" as const })),
    ...posts.filter((p) => p.read).map((p) => ({ id: `t${p.id}`, at: p.at, headline: `Trump: ${p.read!.summary}`, summary: p.text.slice(0, 400), source: "Truth Social", url: p.url, symbols: p.read!.tickers, kind: "trump" as const })),
  ];
  cache.items = rankFeed(items, bySym, now);
  cache.at = Date.now();
  return cache.items;
}

export interface BreakingItem { id: string; at: string; headline: string; url: string; symbols: string[]; source: string; why: string; kind: FeedItem["kind"] }

/**
 * Pure: the running ticker's items. The last 3 hours' stories that look like breaking news: an event word (halt,
 * downgrade, FDA, guidance, merger…), several stories piling onto one stock, a stock on one of the scout's cards, a
 * Trump post or a claim from the rumor sources already reported. Re-posts of older news never count. Newest first;
 * topped up with the latest headlines when the hour is quiet.
 */
export function breakingNews(items: FeedItem[], now: Date, max = 30, minShown = 10): BreakingItem[] {
  const recent = items.filter((i) => !i.repostedAt && now.getTime() - Date.parse(i.at) <= 3 * 3600_000 && Date.parse(i.at) <= now.getTime() + 60_000);
  const why = (i: FeedItem) => (i.kind === "trump" ? "Trump" : i.kind === "rumor" ? "from rumors" : i.event ? i.event : i.cardIds.length ? "on your cards" : i.buzz >= 3 ? `${i.buzz} stories` : "");
  const strong = recent.filter((i) => why(i));
  const pick = strong.length >= minShown ? strong : [...strong, ...recent.filter((i) => !why(i)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, minShown - strong.length)];
  return pick.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max).map((i) => ({ id: i.id, at: i.at, headline: i.headline, url: i.url, symbols: i.symbols.slice(0, 3), source: i.source, why: why(i), kind: i.kind }));
}
