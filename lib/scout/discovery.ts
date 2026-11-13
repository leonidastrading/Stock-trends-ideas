/**
 * Discovery: the part of the daily scan that reads what moved in the last day
 * (every headline on the news stream, Stocktwits' trending list, Polymarket's
 * biggest odds moves, Hacker News' front page, Google's rising queries) and
 * asks the model to propose candidates the watch-list would not have found.
 * Each proposal then goes through the normal research step and gates.
 */
import { SCOUT, KINDS, KIND_LABEL, type Kind } from "@/config/scout";
import { z } from "zod";
import type { MarketData, NewsItem } from "../alpaca";
import { getJson } from "../http";
import { trendingNow } from "../sources/googletrends";
import { isMainstream } from "../sources/news";
import { marketOdds } from "../sources/polymarket";
import type { StTrending } from "../sources/stocktwits";
import { dateStr, daysAgo } from "../sources/types";
import type { Signal } from "../sources";
import { normalizeTicker } from "./tickers";

// --------------------------------------------------------------- the pulse

export interface TickerPulse { symbol: string; stories: number; mainstream: number; headlines: string[] }
export interface Pulse {
  date: string;
  headlinesRead: number;
  /** Tickers by headline count in the last 24 hours. */
  topTickers: TickerPulse[];
  /** Headlines whose wording points at demand, supply or capacity changes (second-order material). */
  supplyDemand: Array<{ at: string; headline: string; symbols: string[] }>;
  stocktwits: Array<{ symbol: string; rank: number; watchers: number | null; why: string | null }>;
  polymarket: Array<{ question: string; yes: number; weekChange: number; endDate: string | null }>;
  hackerNews: string[];
  risingQueries: Array<{ title: string; traffic: string }>;
  problems: string[];
}

const SUPPLY_DEMAND = /\b(backlog|sold out|sell(?:ing)? out|waitlist|shortage|capacity|record (?:demand|orders|bookings)|order(?:s)? (?:surge|jump|double)|price (?:increase|hike)|raises? (?:guidance|outlook|forecast)|supply (?:deal|agreement|constraint)|multi-?year (?:contract|agreement)|expands? (?:production|capacity)|new (?:plant|factory|facility)|lead times?)\b/i;

/** Pure: aggregate a day's headlines by ticker and pull out the supply/demand wording. */
export function summarizeNews(items: NewsItem[], topN = 30): Pick<Pulse, "topTickers" | "supplyDemand" | "headlinesRead"> {
  const by = new Map<string, TickerPulse>();
  for (const n of items) {
    if (n.symbols.length > 6) continue; // sector round-ups
    const main = isMainstream(n);
    for (const s of n.symbols) {
      const t = by.get(s) ?? { symbol: s, stories: 0, mainstream: 0, headlines: [] };
      t.stories++;
      if (main) t.mainstream++;
      if (t.headlines.length < 3) t.headlines.push(n.headline);
      by.set(s, t);
    }
  }
  const topTickers = [...by.values()].sort((a, b) => b.stories - a.stories).slice(0, topN);
  const supplyDemand = items.filter((n) => n.symbols.length <= 6 && SUPPLY_DEMAND.test(`${n.headline} ${n.summary}`)).slice(0, 60).map((n) => ({ at: n.ts.slice(0, 10), headline: n.headline, symbols: n.symbols }));
  return { topTickers, supplyDemand, headlinesRead: items.length };
}

export async function gatherPulse(data: MarketData | null, now: Date, fetchImpl?: typeof fetch): Promise<Pulse> {
  const problems: string[] = [];
  const pulse: Pulse = { date: dateStr(now), headlinesRead: 0, topTickers: [], supplyDemand: [], stocktwits: [], polymarket: [], hackerNews: [], risingQueries: [], problems };
  if (data) {
    try {
      Object.assign(pulse, summarizeNews(await data.getNews([], daysAgo(now, 1), now, 1500)));
    } catch (err) {
      problems.push(`news stream: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else problems.push("news stream: Alpaca keys not set");
  const UA = { "user-agent": "Mozilla/5.0 (trend-scout)", accept: "application/json" };
  await Promise.all([
    getJson<{ symbols?: StTrending[] }>("https://api.stocktwits.com/api/2/trending/symbols/equities.json", { headers: UA, fetchImpl, cacheMs: 30 * 60000 })
      .then((r) => { pulse.stocktwits = (r.symbols ?? []).slice(0, 20).map((s, i) => ({ symbol: s.symbol, rank: i + 1, watchers: s.watchlist_count ?? null, why: s.trends?.summary?.trim() || null })); })
      .catch((err) => problems.push(`stocktwits: ${err instanceof Error ? err.message : String(err)}`)),
    getJson<Array<{ question: string; outcomes?: string; outcomePrices?: string; oneWeekPriceChange?: number; endDate?: string; volume24hr?: number }>>("https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=100", { headers: UA, fetchImpl, cacheMs: 30 * 60000 })
      .then((ms) => {
        pulse.polymarket = ms.map((m) => ({ m, o: marketOdds(m) })).filter((x) => x.o && x.o.weekChange !== null && Math.abs(x.o.weekChange) >= SCOUT.minOddsMovePoints)
          .sort((a, b) => Math.abs(b.o!.weekChange!) - Math.abs(a.o!.weekChange!)).slice(0, 15)
          .map(({ m, o }) => ({ question: m.question, yes: o!.yes, weekChange: o!.weekChange!, endDate: m.endDate?.slice(0, 10) ?? null }));
      })
      .catch((err) => problems.push(`polymarket: ${err instanceof Error ? err.message : String(err)}`)),
    getJson<{ hits: Array<{ title: string }> }>("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", { fetchImpl, cacheMs: 30 * 60000 })
      .then((r) => { pulse.hackerNews = r.hits.map((h) => h.title); })
      .catch((err) => problems.push(`hacker news: ${err instanceof Error ? err.message : String(err)}`)),
    trendingNow(fetchImpl).then((q) => { pulse.risingQueries = q.slice(0, 20); }).catch((err) => problems.push(`google rising queries: ${err instanceof Error ? err.message : String(err)}`)),
  ]);
  return pulse;
}

// ------------------------------------------------------------------ triage

export const TRIAGE_SYSTEM_PROMPT = `You are the discovery step of a paper-only "trend scout". Once a day you read what moved in the last 24 hours (every headline on a market news stream, Stocktwits' trending list, the largest prediction-market odds moves, Hacker News' front page, Google's rising queries) and propose a few candidates for research: observable real-world changes that should show up in a listed company's results before analysts move their numbers.

What makes a good candidate:
- Second-order: a big theme or a customer's spending that creates demand for a supplier nobody is talking about.
- Platform: an app, site or service gaining users or usage fast.
- Re-rating: a large company whose business line or cost change the market is undervaluing.
- Event: a policy, legal or macro outcome with a clear listed winner or loser, where the odds just moved.
- Consumer: a product selling out or going viral.

What to avoid: the names dominating today's headlines (they are already obvious), earnings reactions, analyst upgrades, and anything whose only evidence is price action. Prefer the thing one step behind the headline. A candidate is a short searchable term (a product, app, theme or supply-chain phrase), a kind, and the tickers most directly exposed. Propose at most the number asked for, fewer if nothing qualifies, and say in one sentence what you saw that made you propose it.`;

export const triageSchema = z.object({
  candidates: z.array(z.object({
    term: z.string().min(2).max(80),
    kind: z.enum(KINDS),
    tickers: z.array(z.string()).min(1).max(8),
    why: z.string().min(1).max(400),
    seen_in: z.array(z.string()).max(5),
  })).max(10),
  read: z.string().max(600),
});
export type Triage = z.infer<typeof triageSchema>;

export const TRIAGE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["candidates", "read"],
  properties: {
    candidates: {
      type: "array", description: "at most the number asked for",
      items: {
        type: "object", additionalProperties: false, required: ["term", "kind", "tickers", "why", "seen_in"],
        properties: {
          term: { type: "string", description: "short searchable term: product, app, theme or supply-chain phrase" },
          kind: { type: "string", enum: [...KINDS] },
          tickers: { type: "array", items: { type: "string" }, description: "1 to 5 US ticker symbols (e.g. NVDA, BRK.B; no $ sign), most direct exposure first" },
          why: { type: "string", description: "one sentence: what you saw" },
          seen_in: { type: "array", items: { type: "string" }, description: "which inputs: news, stocktwits, polymarket, hacker_news, rising_queries" },
        },
      },
    },
    read: { type: "string", description: "two sentences on what the day looked like" },
  },
} as const;

export function buildTriagePrompt(p: Pulse, maxCandidates: number, avoid: string[], preferences: string | null = null): string {
  const L: string[] = [];
  L.push(`Date: ${p.date}. Propose at most ${maxCandidates} candidates. Give platform, second-order and re-rating ideas at least as much attention as consumer trends.`);
  if (preferences) L.push(`\n${preferences}`);
  if (avoid.length) L.push(`Already researched recently (do not propose again): ${avoid.join("; ")}.`);
  L.push(`\nNews stream: ${p.headlinesRead} headlines in 24h. Tickers with the most headlines (these are the obvious names; look one step behind them):`);
  for (const t of p.topTickers) L.push(`- ${t.symbol}: ${t.stories} stories (${t.mainstream} mainstream). ${t.headlines.join(" | ")}`);
  if (p.supplyDemand.length) {
    L.push(`\nHeadlines with supply, demand or capacity wording:`);
    for (const h of p.supplyDemand) L.push(`- [${h.symbols.join(",") || "no ticker"}] ${h.headline}`);
  }
  if (p.stocktwits.length) {
    L.push(`\nStocktwits trending list (rank, watchers, why):`);
    for (const s of p.stocktwits) L.push(`- #${s.rank} ${s.symbol}${s.watchers ? ` (${s.watchers.toLocaleString("en-US")} watchers)` : ""}${s.why ? `: ${s.why.slice(0, 220)}` : ""}`);
  }
  if (p.polymarket.length) {
    L.push(`\nPrediction markets with the largest 7-day odds moves:`);
    for (const m of p.polymarket) L.push(`- "${m.question}": ${m.yes}% yes (${m.weekChange >= 0 ? "+" : ""}${m.weekChange} pts in 7d)${m.endDate ? `, resolves ${m.endDate}` : ""}`);
  }
  if (p.hackerNews.length) L.push(`\nHacker News front page: ${p.hackerNews.join(" | ")}`);
  if (p.risingQueries.length) L.push(`\nGoogle rising queries (US): ${p.risingQueries.map((q) => `${q.title} (${q.traffic})`).join("; ")}`);
  if (p.problems.length) L.push(`\nInputs not available today: ${p.problems.join("; ")}.`);
  L.push(`\nKinds: ${KINDS.map((k) => `${k} (${KIND_LABEL[k]})`).join(", ")}. Reply with the JSON object.`);
  return L.join("\n");
}

export function parseTriage(text: string): Triage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("triage reply is not valid JSON");
  }
  const r = triageSchema.safeParse(raw);
  if (!r.success) throw new Error(`triage failed validation: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  // Tickers that are not US symbols are dropped; a candidate with none left is dropped.
  const candidates = r.data.candidates
    .map((c) => ({ ...c, tickers: c.tickers.map(normalizeTicker).filter((t): t is string => !!t).slice(0, 5) }))
    .filter((c) => c.tickers.length);
  return { ...r.data, candidates };
}

/** The trigger stored with a discovered candidate, in the same shape as the scan's accelerating signals. */
export function triggerFor(c: Triage["candidates"][number], date: string): Signal[] {
  return [{ source: "discovery", metric: "proposed", value: 1, baseline: null, changeVs12m: null, asOf: date, note: `${c.why} (seen in: ${c.seen_in.join(", ") || "?"})`, detail: { seen_in: c.seen_in } }];
}

export type KindOf = Kind;
