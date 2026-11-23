/**
 * Top news, last 24 hours: the ten most important stories of the day at the top of the News tab. Every half hour the
 * light model reads the day's strongest candidates (the News tab's own ranking, without its freshness decay) and
 * picks the ten that matter most to markets, with a one-line why. Its list also gets general business and world headlines
 * (Google News top, business and world stories), which the ticker-tagged feed misses or ranks low. Until a pick exists (or when the AI is off or over
 * its cap) the rule-based ranking stands in.
 */
import { z } from "zod";
import { LIGHT_MODEL } from "@/config/scout";
import type { FeedItem } from "./newsfeed";
import type { ResearchDeps } from "./research";
import { topReason } from "./top-story";
import * as store from "./store";
import { toEt } from "../time";
import { getText } from "../http";
export { TOP_NEWS_PROMPT, TOP_NEWS_SCHEMA } from "./top-news-prompt";

export const TOP_NEWS = { candidates: 70, fromFeed: 50, general: 45, picks: 10, everyMin: 30, maxAgeH: 3 };

/** Law firms' class-action ads ("investors have opportunity to lead… lawsuit"): never top news. */
export const CLASS_ACTION_AD = /\b(securities fraud lawsuit|class action (lawsuit )?(has been )?filed (on behalf|against)|announces .{0,30}class action|encourages .{0,30}investors|investors? (have|has|who) .{0,40}(opportunity|lead|contact)|shareholder alert|investor alert|investor notice|rosen law|pomerantz|levi & korsinsky|bragar|bronstein|faruqi|glancy|kessler topaz|schall law|sbs law|robbins geller|reminds investors|deadline alert)\b/i;

const reply = z.object({ picks: z.array(z.object({ id: z.string(), why: z.string().catch("") })).catch([]) });

export interface TopPick { id: string; at: string; headline: string; url: string; source: string; symbols: string[]; why: string; kind: FeedItem["kind"] }
export interface TopNews { at: string; by: "ai" | "rules"; picks: TopPick[] }

const ageH = (i: FeedItem, now: Date) => Math.max(0, (now.getTime() - Date.parse(i.at)) / 3600_000);
/** Pure: the News tab's score without its freshness decay (how big the story is, not how new). */
export const weight = (i: FeedItem, now: Date) => i.score / Math.pow(0.5, ageH(i, now) / 6);
const bare = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Pure: the day's candidates, strongest first: last 24 hours, no re-posts or routine pauses, one per headline. */
export function candidates(items: FeedItem[], now: Date, max = TOP_NEWS.candidates): FeedItem[] {
  // The same headline twice: keep the earliest (the original report).
  const first = new Map<string, FeedItem>();
  for (const i of items.filter((i) => !i.repostedAt && i.event !== "paused" && ageH(i, now) <= 24 && Date.parse(i.at) <= now.getTime() + 60_000 && !CLASS_ACTION_AD.test(i.headline))) {
    const k = bare(i.headline).slice(0, 80), had = first.get(k);
    if (!had || i.at < had.at) first.set(k, i);
  }
  return [...first.values()].sort((a, b) => weight(b, now) - weight(a, now) || b.at.localeCompare(a.at)).slice(0, max);
}

const pick = (i: FeedItem, why: string): TopPick => ({ id: i.id, at: i.at, headline: i.headline, url: i.url, source: i.source, symbols: i.symbols.slice(0, 4), why, kind: i.kind });

/** Pure: the rule-based ten: strongest first, at most one story per stock. */
export function ruleTop(items: FeedItem[], now: Date, n = TOP_NEWS.picks): TopPick[] {
  const used = new Set<string>(); const out: TopPick[] = [];
  for (const i of candidates(items, now)) {
    if (i.symbols.length && i.symbols.every((s) => used.has(s))) continue;
    i.symbols.forEach((s) => used.add(s));
    out.push(pick(i, topReason(i)));
    if (out.length >= n) break;
  }
  return out;
}

const GOOGLE_FEEDS: Array<[string, string]> = [
  ["top", "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"],
  ["business", "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en"],
  ["world", "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en"],
];
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

/** Pure: a Google News RSS page as feed items ("Headline - Outlet" split into headline and source), newest kept to 24 hours. */
export function parseGoogleNews(xml: string, now: Date): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t: string) => decode(m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`))?.[1] ?? "");
    const title = tag("title"), link = tag("link"), at = Date.parse(tag("pubDate")), outlet = tag("source");
    if (!title || !link || !Number.isFinite(at) || now.getTime() - at > 24 * 3600_000) continue;
    const headline = outlet && title.endsWith(` - ${outlet}`) ? title.slice(0, -(outlet.length + 3)) : title.replace(/ - [^-]{2,40}$/, "");
    out.push({ id: `g${(out.length + 1).toString(36)}${Math.abs([...link].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`, at: new Date(at).toISOString(), headline, summary: "", source: outlet || "Google News", url: link, symbols: [], event: null, cardIds: [], buzz: 0, score: 0, kind: "news" });
  }
  return out;
}

/** General business and world headlines (Google News: top stories, business, world), last 24 hours. */
export async function generalNews(now: Date, fetchImpl?: typeof fetch): Promise<FeedItem[]> {
  const pages = await Promise.all(GOOGLE_FEEDS.map(([, url]) => getText(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "application/rss+xml, application/xml, text/xml, */*" }, fetchImpl, cacheMs: 10 * 60_000, timeoutMs: 8000, retries: 1 }).catch(() => "")));
  return pages.flatMap((x) => parseGoogleNews(x, now));
}

/** Pure: what the model reads: the feed's strongest, its untagged general headlines, and the general news, one per headline. */
export function aiCandidates(items: FeedItem[], general: FeedItem[], now: Date): FeedItem[] {
  const top = candidates(items, now, TOP_NEWS.fromFeed);
  const untagged = candidates(items.filter((i) => i.kind === "news" && i.symbols.length === 0), now, 200).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
  const seen = new Set<string>(); const out: FeedItem[] = [];
  for (const i of [...top, ...untagged, ...candidates(general, now, 300).sort((a, b) => b.at.localeCompare(a.at))]) {
    const k = bare(i.headline).slice(0, 60);
    if (seen.has(k) || seen.has(i.id)) continue;
    seen.add(k); seen.add(i.id); out.push(i);
    if (out.length >= TOP_NEWS.fromFeed + 15 + TOP_NEWS.general) break;
  }
  return out;
}

/** Pure: the model's picks mapped onto the candidates (unknown ids and repeats dropped). */
export function applyPicks(cands: FeedItem[], picks: Array<{ id: string; why: string }>, n = TOP_NEWS.picks): TopPick[] {
  const by = new Map(cands.map((c) => [c.id, c])); const seen = new Set<string>();
  return picks.filter((p) => by.has(p.id) && !seen.has(p.id) && seen.add(p.id)).slice(0, n).map((p) => pick(by.get(p.id)!, p.why.trim()));
}

/** Pure: the list the model reads. */
export function promptList(cands: FeedItem[]): string {
  return cands.map((c) => `[${c.id}] ${toEt(new Date(c.at)).date} ${String(Math.floor(toEt(new Date(c.at)).minutes / 60)).padStart(2, "0")}:${String(toEt(new Date(c.at)).minutes % 60).padStart(2, "0")} ET · ${c.source}${c.symbols.length ? ` · ${c.symbols.slice(0, 4).join(", ")}` : ""}\n${c.headline}${c.summary ? `\n${c.summary.replace(/\s+/g, " ").slice(0, 220)}` : ""}`).join("\n\n");
}

/** One pass: the model's ten, saved for the News tab. */
export async function runTopNews(deps: ResearchDeps): Promise<string> {
  const { newsFeed } = await import("./newsfeed");
  const [items, general] = await Promise.all([newsFeed(deps.now), generalNews(deps.now).catch(() => [] as FeedItem[])]);
  const cands = aiCandidates(items, general, deps.now);
  if (cands.length < 3) return "top news: too few stories";
  const today = toEt(deps.now).date;
  if ((await store.spendOn(today)).cost >= (await store.loadSettings()).dailyCapUsd) return "top news: daily AI cap reached (rules ranking shown)";
  const r = await deps.callModel({ model: LIGHT_MODEL, effort: "low", purpose: "top_news", user: `Now: ${deps.now.toISOString()}\n\n${promptList(cands)}\n\nReply with the JSON object.` });
  await store.logLlmCall({ etDate: today, model: LIGHT_MODEL, purpose: "top_news", usage: r.usage, costUsd: r.costUsd, ok: true });
  const picks = applyPicks(cands, reply.parse(JSON.parse(r.text)).picks);
  if (!picks.length) return "top news: the model picked nothing usable";
  await store.cachePut("topnews", { at: deps.now.toISOString(), by: "ai", picks } satisfies TopNews);
  return `top news: ${picks.length} picked from ${cands.length} (${general.length} general headlines)`;
}

/** The latest pick when fresh enough, else the rules' ten from the live feed. */
export async function topNews(items: FeedItem[], now = new Date()): Promise<TopNews> {
  const hit = await store.cacheGet<TopNews>("topnews").catch(() => null);
  if (hit?.data?.picks?.length && now.getTime() - Date.parse(hit.data.at) < TOP_NEWS.maxAgeH * 3600_000) return hit.data;
  return { at: now.toISOString(), by: "rules", picks: ruleTop(items, now) };
}
