/**
 * Top news, last 24 hours: the ten most important stories of the day at the top of the News tab. Every half hour the
 * light model reads the day's strongest candidates (the News tab's own ranking, without its freshness decay) and
 * picks the ten that matter most to markets, with a one-line why. Until a pick exists (or when the AI is off or over
 * its cap) the rule-based ranking stands in.
 */
import { z } from "zod";
import { LIGHT_MODEL } from "@/config/scout";
import type { FeedItem } from "./newsfeed";
import type { ResearchDeps } from "./research";
import { topReason } from "./top-story";
import * as store from "./store";
import { toEt } from "../time";
export { TOP_NEWS_PROMPT, TOP_NEWS_SCHEMA } from "./top-news-prompt";

export const TOP_NEWS = { candidates: 70, picks: 10, everyMin: 30, maxAgeH: 3 };

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
  for (const i of items.filter((i) => !i.repostedAt && i.event !== "paused" && ageH(i, now) <= 24 && Date.parse(i.at) <= now.getTime() + 60_000)) {
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
  const items = await newsFeed(deps.now);
  const cands = candidates(items, deps.now);
  if (cands.length < 3) return "top news: too few stories";
  const today = toEt(deps.now).date;
  if ((await store.spendOn(today)).cost >= (await store.loadSettings()).dailyCapUsd) return "top news: daily AI cap reached (rules ranking shown)";
  const r = await deps.callModel({ model: LIGHT_MODEL, effort: "low", purpose: "top_news", user: `Now: ${deps.now.toISOString()}\n\n${promptList(cands)}\n\nReply with the JSON object.` });
  await store.logLlmCall({ etDate: today, model: LIGHT_MODEL, purpose: "top_news", usage: r.usage, costUsd: r.costUsd, ok: true });
  const picks = applyPicks(cands, reply.parse(JSON.parse(r.text)).picks);
  if (!picks.length) return "top news: the model picked nothing usable";
  await store.cachePut("topnews", { at: deps.now.toISOString(), by: "ai", picks } satisfies TopNews);
  return `top news: ${picks.length} picked from ${cands.length}`;
}

/** The latest pick when fresh enough, else the rules' ten from the live feed. */
export async function topNews(items: FeedItem[], now = new Date()): Promise<TopNews> {
  const hit = await store.cacheGet<TopNews>("topnews").catch(() => null);
  if (hit?.data?.picks?.length && now.getTime() - Date.parse(hit.data.at) < TOP_NEWS.maxAgeH * 3600_000) return hit.data;
  return { at: now.toISOString(), by: "rules", picks: ruleTop(items, now) };
}
