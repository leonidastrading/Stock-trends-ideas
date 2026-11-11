/**
 * The existing news stream (Alpaca / Benzinga headlines, the same feed the
 * Swing ideas app ingests). Used mainly to measure how much coverage an idea
 * has *already* had: stories tagged with the idea's tickers in 30 days, and how
 * many came from mainstream outlets.
 */
import { SCOUT } from "@/config/scout";
import { marketDataFromEnv, type MarketData, type NewsItem } from "../alpaca";
import { dateStr, daysAgo, guarded, type Source } from "./types";

export function isMainstream(n: NewsItem): boolean {
  let host = "";
  try { host = new URL(n.url).host.replace(/^www\./, ""); } catch { /* no url */ }
  const src = n.source.toLowerCase();
  return SCOUT.mainstreamHosts.some((h) => host.endsWith(h) || src.includes(h.split(".")[0]));
}

/** Pure: coverage counts over a list of stories. */
export function coverage(items: NewsItem[]) {
  const mainstream = items.filter(isMainstream).length;
  return { stories: items.length, mainstream, sources: new Set(items.map((i) => i.source)).size };
}

export function newsSource(data: MarketData | null = marketDataFromEnv()): Source {
  return {
    id: "news",
    label: "News stream (Alpaca/Benzinga)",
    about: "Headlines tagged with the idea's tickers over 30 days: how much coverage it has already had.",
    configured: () => data !== null,
    probe: (ctx) =>
      guarded("news", async () => {
        if (!data) return { source: "news", status: "missing", detail: "ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set", signals: [] };
        if (!ctx.tickers.length) return { source: "news", status: "ok", detail: "no tickers to look up yet", signals: [] };
        const items = await data.getNews(ctx.tickers, daysAgo(ctx.now, 30), ctx.now, 300);
        const c = coverage(items);
        return {
          source: "news", status: "ok", signals: [{
            source: "news", metric: "stories_30d", value: c.stories, baseline: null, changeVs12m: null, asOf: dateStr(ctx.now),
            note: `${c.stories} news stories tagged ${ctx.tickers.join("/")} in 30 days, ${c.mainstream} from mainstream outlets, ${c.sources} distinct sources`,
            detail: { mainstream_30d: c.mainstream, recent: items.slice(0, 8).map((i) => ({ at: i.ts.slice(0, 10), headline: i.headline, source: i.source })) },
          }],
        };
      }),
  };
}
