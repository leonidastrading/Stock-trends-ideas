/**
 * App-store top charts. Apple publishes a public JSON feed of the US top free
 * apps; Google Play has no public feed, so it is marked missing. Rank changes
 * need history: the base comes from the scout's own stored daily ranks.
 */
import { getJson } from "../http";
import { dateStr, guarded, type Source } from "./types";

interface Feed { feed: { results: Array<{ name: string; artistName: string; url: string }> } }

/** Pure: 1-based rank of the first app whose name or publisher mentions any of the terms. */
export function findRank(results: Array<{ name: string; artistName: string }>, terms: string[]): { rank: number; name: string; artist: string } | null {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const i = results.findIndex((r) => needles.some((n) => r.name.toLowerCase().includes(n) || r.artistName.toLowerCase().includes(n)));
  return i < 0 ? null : { rank: i + 1, name: results[i].name, artist: results[i].artistName };
}

export const appStore: Source = {
  id: "app_store",
  label: "Apple App Store top charts",
  about: "Rank changes for apps owned by listed companies (US top 200 free apps). Google Play: no public feed, marked missing.",
  configured: () => true,
  probe: (ctx) =>
    guarded("app_store", async () => {
      const feed = await getJson<Feed>("https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/200/apps.json", { fetchImpl: ctx.fetchImpl, cacheMs: 60 * 60000 });
      const hit = findRank(feed.feed.results, [ctx.term]);
      if (!hit) return { source: "app_store", status: "ok", detail: `no top-200 app matches "${ctx.term}"`, signals: [] };
      return {
        source: "app_store", status: "ok", signals: [{
          source: "app_store", metric: "top_free_rank", value: hit.rank, baseline: null, changeVs12m: null, asOf: dateStr(ctx.now),
          note: `"${hit.name}" (${hit.artist}) is #${hit.rank} in the US top free apps (12-month base from stored history; lower is better)`,
          detail: { app: hit.name, publisher: hit.artist, lower_is_better: true },
        }],
      };
    }),
};
