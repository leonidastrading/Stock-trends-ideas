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
  google_trends: 1, youtube: 1, reddit: 1, wikipedia: 1, app_store: 1, hacker_news: 1, news: 1, polymarket: 1,
  edgar: 2, // 1 = full-text search only (blocked from cloud); 2 = data.sec.gov per-ticker filings, 8-K events, revenue YoY
  stocktwits: 2, // 1 = missing; 2 = public trending list + symbol streams (the Trending Five endpoints)
};

/** Probe every source for one term, in parallel, never throwing. */
export async function probeAll(sources: Source[], ctx: ProbeContext): Promise<SourceResult[]> {
  return Promise.all(sources.map((s) => (s.configured(ctx.env) ? s.probe(ctx) : Promise.resolve<SourceResult>({ source: s.id, status: "missing", detail: "not configured", signals: [] }))));
}

export type { ProbeContext, Signal, Source, SourceResult, SourceStatus } from "./types";
