/**
 * Broad "what is the world paying attention to" feeds, for the Dots desk. Each is public, needs no key, and was
 * checked from Vercel's network on 2026-11-19:
 * - Google Trends daily trending searches in the US (RSS), with the news stories behind each;
 * - Wikipedia's most-read English articles yesterday (Wikimedia pageviews API);
 * - Polymarket's most-traded open markets in the last 24 hours (what people are betting real money on);
 * - the Hacker News front page (what technologists are reading).
 * (Reddit refuses cloud servers and Amazon's Movers & Shakers is drawn by script, so neither is here.)
 */
import { getText } from "../http";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)" };

export interface Signal { feed: "google_trends" | "wikipedia" | "polymarket" | "hacker_news"; text: string }

const dec = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

/** Pure: Google Trends trending-search RSS items: the search, its traffic, and the headlines behind it. */
export function parseTrends(xml: string): Signal[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1];
    const title = dec(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? "");
    const traffic = dec(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(it)?.[1] ?? "");
    const news = [...it.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((x) => dec(x[1])).slice(0, 2);
    return { feed: "google_trends" as const, text: `${title}${traffic ? ` (${traffic} searches)` : ""}${news.length ? `: ${news.join(" / ")}` : ""}` };
  }).filter((s) => s.text);
}

/** Pure: Wikipedia's top articles, without the site's own pages. */
export function parseWikiTop(json: string, max = 50): Signal[] {
  const arts = (JSON.parse(json) as { items?: Array<{ articles?: Array<{ article: string; views: number }> }> }).items?.[0]?.articles ?? [];
  return arts.filter((a) => !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|User:|Template:|-$|\.xxx$)/.test(a.article))
    .slice(0, max).map((a) => ({ feed: "wikipedia" as const, text: `${a.article.replace(/_/g, " ")} (${a.views.toLocaleString("en-US")} views)` }));
}

/** Pure: Polymarket's busiest markets, without sports games. */
export function parsePolymarket(json: string, max = 30): Signal[] {
  const ms = JSON.parse(json) as Array<{ question?: string; outcomePrices?: string; volume24hr?: number }>;
  return ms.filter((m) => m.question && !/ vs\.? /i.test(m.question)).slice(0, max).map((m) => {
    let yes = "";
    try { const p = JSON.parse(m.outcomePrices ?? "[]") as string[]; if (p[0]) yes = ` (${Math.round(Number(p[0]) * 100)}% yes)`; } catch { /* no prices */ }
    return { feed: "polymarket" as const, text: `${m.question}${yes}${m.volume24hr ? `, $${Math.round(m.volume24hr / 1000)}k traded in 24h` : ""}` };
  });
}

/** Pure: Hacker News front-page titles. */
export function parseHn(json: string): Signal[] {
  return ((JSON.parse(json) as { hits?: Array<{ title?: string; points?: number }> }).hits ?? []).filter((h) => h.title).map((h) => ({ feed: "hacker_news" as const, text: `${h.title}${h.points ? ` (${h.points} points)` : ""}` }));
}

/** All four feeds, best effort (a feed that fails is skipped). */
export async function discoverySignals(now: Date, fetchImpl?: typeof fetch): Promise<{ signals: Signal[]; failed: string[] }> {
  const y = new Date(now.getTime() - 86400_000);
  const ymd = `${y.getUTCFullYear()}/${String(y.getUTCMonth() + 1).padStart(2, "0")}/${String(y.getUTCDate()).padStart(2, "0")}`;
  const get = (url: string) => getText(url, { headers: UA, fetchImpl, cacheMs: 60 * 60_000, timeoutMs: 10_000, retries: 1 });
  const feeds: Array<[string, () => Promise<Signal[]>]> = [
    ["google_trends", async () => parseTrends(await get("https://trends.google.com/trending/rss?geo=US"))],
    ["wikipedia", async () => parseWikiTop(await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${ymd}`))],
    ["polymarket", async () => parsePolymarket(await get("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=60"))],
    ["hacker_news", async () => parseHn(await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30"))],
  ];
  const out = await Promise.all(feeds.map(async ([name, f]) => { try { return { name, s: await f() }; } catch { return { name, s: null }; } }));
  return { signals: out.flatMap((o) => o.s ?? []), failed: out.filter((o) => !o.s).map((o) => o.name) };
}
