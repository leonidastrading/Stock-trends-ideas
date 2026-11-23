/**
 * newsfilter.io (NEWSFILTER_API_KEY, optional): general and government news the ticker-tagged feeds miss, for the
 * News tab's "Top news". CNBC, BNN Bloomberg, the White House, the Fed, the Treasury, the SEC, the Department of War,
 * the Justice Department and FDA approvals. API v2: POST https://api.newsfilter.io/search with a Lucene query.
 *
 * The free plan allows 100 requests a day, 5 articles per request, with news an hour late. So the reader runs at
 * most every 2 hours, makes 3 requests, keeps what it has read for 26 hours, and stops at 80 requests a day.
 */
import type { FeedItem } from "../scout/newsfeed";
import * as store from "../scout/store";

export const NEWSFILTER = { everyMin: 110, keepH: 26, maxPerDay: 80, size: 5 };

/** What each pass asks for: big media, then government and regulators. */
export const NF_QUERIES = [
  "source.id:(cnbc OR bnn-bloomberg)",
  "source.id:(white-house OR fed-speeches OR us-treasury OR sec-press-releases)",
  "source.id:(fda-approved-drugs OR us-dod OR us-doj OR techcrunch)",
];

interface NfArticle { id: string; title?: string; description?: string; url?: string; sourceUrl?: string; publishedAt?: string; source?: { id?: string; name?: string }; symbols?: string[] }

/** Pure: newsfilter articles as feed items (the publisher's link when there is one). */
export function parseNewsfilter(json: unknown): FeedItem[] {
  const arts = ((json as { articles?: NfArticle[] })?.articles ?? []).filter((a) => a?.id && a.title && a.publishedAt);
  return arts.map((a) => ({
    id: `nf${a.id}`, at: new Date(a.publishedAt!).toISOString(), headline: a.title!.trim(), summary: (a.description ?? "").slice(0, 600),
    source: a.source?.name || a.source?.id || "newsfilter", url: a.sourceUrl || a.url || "https://newsfilter.io",
    symbols: (a.symbols ?? []).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)).slice(0, 8),
    event: null, cardIds: [], buzz: 0, score: 0, kind: "news" as const,
  }));
}

/** Pure: merge new items into the kept ones (by id), dropping anything older than `keepH` hours. */
export function mergeKept(kept: FeedItem[], fresh: FeedItem[], now: Date, keepH = NEWSFILTER.keepH): FeedItem[] {
  const by = new Map(kept.map((i) => [i.id, i]));
  for (const i of fresh) by.set(i.id, i);
  return [...by.values()].filter((i) => now.getTime() - Date.parse(i.at) <= keepH * 3600_000).sort((a, b) => b.at.localeCompare(a.at));
}

async function search(query: string, key: string, fetchImpl: typeof fetch): Promise<FeedItem[]> {
  const res = await fetchImpl("https://api.newsfilter.io/search", {
    method: "POST", headers: { Authorization: key, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, from: 0, size: NEWSFILTER.size, sort: { publishedAt: { order: "desc" } } }), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`newsfilter ${res.status}`);
  return parseNewsfilter(await res.json());
}

interface Kept { items: FeedItem[]; readAt: string; day: string; used: number; error?: string | null }

/** The last day's newsfilter items: re-read at most every ~2 hours within the daily request budget. */
export async function newsfilterRecent(now = new Date(), env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<FeedItem[]> {
  const key = env.NEWSFILTER_API_KEY?.trim();
  if (!key) return [];
  const hit = (await store.cacheGet<Kept>("newsfilter:recent").catch(() => null))?.data ?? null;
  const day = now.toISOString().slice(0, 10);
  const used = hit?.day === day ? hit.used : 0;
  const due = !hit || now.getTime() - Date.parse(hit.readAt) >= NEWSFILTER.everyMin * 60_000;
  if (!due || used + NF_QUERIES.length > NEWSFILTER.maxPerDay) return mergeKept(hit?.items ?? [], [], now);
  let fresh: FeedItem[] = [], error: string | null = null, calls = 0;
  for (const q of NF_QUERIES) {
    calls++;
    try { fresh = fresh.concat(await search(q, key, fetchImpl)); } catch (e) { error = e instanceof Error ? e.message : String(e); if (/40[13]/.test(error)) break; }
  }
  const items = mergeKept(hit?.items ?? [], fresh, now);
  await store.cachePut("newsfilter:recent", { items, readAt: now.toISOString(), day, used: used + calls, error } satisfies Kept).catch(() => undefined);
  return items;
}
