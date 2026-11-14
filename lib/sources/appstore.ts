/**
 * App-store top charts. Apple publishes a public JSON feed of the US top free
 * apps (rss.marketingtools.apple.com; the old applemarketingtools host now
 * redirects there); Google Play has no public feed. Rank changes need history:
 * the base comes from the scout's own stored daily ranks.
 *
 * The feed can take 15-20 s to answer, so it is fetched once per scan and shared
 * by every term (a failure is remembered briefly too, so terms do not each wait),
 * with the older iTunes RSS feed as a fallback.
 */
import { getJson } from "../http";
import { dateStr, guarded, type Source } from "./types";

interface Feed { feed: { results: Array<{ name: string; artistName: string; url: string }> } }
interface LegacyFeed { feed: { entry: Array<{ "im:name": { label: string }; "im:artist": { label: string } }> } }
type App = { name: string; artistName: string };

const FEED = "https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json";
const LEGACY = "https://itunes.apple.com/us/rss/topfreeapplications/limit=100/json";
let chart: { at: number; ttl: number; p: Promise<App[]> } | null = null;

async function fetchChart(fetchImpl?: typeof fetch): Promise<App[]> {
  try {
    const f = await getJson<Feed>(FEED, { fetchImpl, cacheMs: 0, timeoutMs: 45000, retries: 1 });
    if (f.feed?.results?.length) return f.feed.results;
    throw new Error("Apple chart feed returned no apps");
  } catch (first) {
    try {
      const l = await getJson<LegacyFeed>(LEGACY, { fetchImpl, cacheMs: 0, timeoutMs: 45000, retries: 1 });
      const apps = (l.feed?.entry ?? []).map((e) => ({ name: e["im:name"]?.label ?? "", artistName: e["im:artist"]?.label ?? "" }));
      if (apps.length) return apps;
    } catch {
      /* report the main feed's error below */
    }
    throw first;
  }
}

/** One download per hour shared by every term; a failure is kept for 10 minutes so a scan does not retry it per term. */
export function topFreeApps(fetchImpl?: typeof fetch, now = Date.now()): Promise<App[]> {
  if (chart && now - chart.at < chart.ttl) return chart.p;
  const entry = { at: now, ttl: 60 * 60000, p: fetchChart(fetchImpl) };
  entry.p.catch(() => { entry.ttl = 10 * 60000; });
  chart = entry;
  return entry.p;
}

export function resetAppChart(): void {
  chart = null;
}

/** Pure: 1-based rank of the first app whose name or publisher mentions any of the terms. */
export function findRank(results: Array<{ name: string; artistName: string }>, terms: string[]): { rank: number; name: string; artist: string } | null {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const i = results.findIndex((r) => needles.some((n) => (r.name ?? "").toLowerCase().includes(n) || (r.artistName ?? "").toLowerCase().includes(n)));
  return i < 0 ? null : { rank: i + 1, name: results[i].name, artist: results[i].artistName };
}

export const appStore: Source = {
  id: "app_store",
  label: "Apple App Store top charts",
  about: "Rank changes for apps owned by listed companies (US top 100 free apps). Google Play: no public feed, marked missing.",
  configured: () => true,
  probe: (ctx) =>
    guarded("app_store", async () => {
      const hit = findRank(await topFreeApps(ctx.fetchImpl), [ctx.term]);
      if (!hit) return { source: "app_store", status: "ok", detail: `no top-100 app matches "${ctx.term}"`, signals: [] };
      return {
        source: "app_store", status: "ok", signals: [{
          source: "app_store", metric: "top_free_rank", value: hit.rank, baseline: null, changeVs12m: null, asOf: dateStr(ctx.now),
          note: `"${hit.name}" (${hit.artist}) is #${hit.rank} in the US top free apps (12-month base from stored history; lower is better)`,
          detail: { app: hit.name, publisher: hit.artist, lower_is_better: true },
        }],
      };
    }),
};
