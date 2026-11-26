/** The version-1 source list. Order matters only for display. The list is part of the version hash. */
import type { MarketData } from "../alpaca";
import { appStore } from "./appstore";
import { edgar } from "./edgar";
import { googleTrends } from "./googletrends";
import { hackerNews } from "./hackernews";
import { newsSource } from "./news";
import { polymarket } from "./polymarket";
import { reddit } from "./reddit";
import { stocktwits } from "./stocktwits";
import type { ProbeContext, Source, SourceResult } from "./types";
import { wikipedia } from "./wikipedia";
import { youtube } from "./youtube";

export function allSources(data: MarketData | null): Source[] {
  return [googleTrends, youtube, reddit, wikipedia, appStore, hackerNews, edgar, newsSource(data), polymarket, stocktwits];
}

export const SOURCE_IDS = ["google_trends", "youtube", "reddit", "wikipedia", "app_store", "hacker_news", "edgar", "news", "polymarket", "stocktwits"] as const;

/** Bump a source's revision when its data source or measurement changes: it starts a new version. */
export const SOURCE_REVISIONS: Record<(typeof SOURCE_IDS)[number], number> = {
  google_trends: 1, youtube: 1, hacker_news: 1, news: 1, polymarket: 1,
  wikipedia: 2, // 1 = searched the term as typed (a desk label found a film, "TXN" found TX Network); 2 = the company's own article for desk cards and bare tickers, or nothing
  reddit: 2, // 1 = Reddit Data API (never approved: Reddit stopped taking requests); 2 = the scout's copy of 9 finance subreddits via the Arctic Shift archive
  app_store: 2, // 1 = applemarketingtools feed, 20 s limit (timed out); 2 = new host, 45 s, shared per scan, iTunes RSS fallback
  edgar: 4, // 1 = full-text search only (blocked from cloud); 2 = data.sec.gov per-ticker filings, 8-K events, revenue YoY; 3 = full-text path fixed (/LATEST/) for the relay; 4 = insider signals re-weighted by our own Form 4 test (after-a-drop boost, lighter clusters, ~90-day horizon)
  stocktwits: 2, // 1 = missing; 2 = public trending list + symbol streams (the Trending Five endpoints)
};

/** Probe every source for one term, in parallel, never throwing. */
/** Sources that measure what people search for or post about a phrase. */
export const SEARCH_SOURCES = new Set(["google_trends", "youtube", "wikipedia", "hacker_news", "reddit", "app_store"]);

export async function probeAll(sources: Source[], ctx: ProbeContext): Promise<SourceResult[]> {
  return Promise.all(sources.map((s) => {
    if (!s.configured(ctx.env)) return Promise.resolve<SourceResult>({ source: s.id, status: "missing", detail: "not configured", signals: [] });
    // A ticker whose company name is also an ordinary word or acronym: what people search for it says nothing about the company.
    if (ctx.subject === "unusable" && SEARCH_SOURCES.has(s.id)) return Promise.resolve<SourceResult>({ source: s.id, status: "ok", detail: "not searched: the name is also an ordinary word or acronym, so a search reading would be about something else", signals: [] });
    return s.probe(ctx);
  }));
}

export type { ProbeContext, Signal, Source, SourceResult, SourceStatus } from "./types";
