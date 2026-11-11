/** YouTube Data API: videos mentioning the term uploaded in 7 days vs the prior 4 weeks, plus their views. Needs YOUTUBE_API_KEY (quota 10,000 units/day; a probe costs ~201). */
import { getJson } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Source } from "./types";

interface SearchResp { pageInfo: { totalResults: number }; items: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; publishedAt: string } }> }
interface VideosResp { items: Array<{ id: string; statistics: { viewCount?: string } }> }

export const youtube: Source = {
  id: "youtube",
  label: "YouTube",
  about: "Upload and view growth for videos mentioning watch-list terms.",
  configured: (env) => !!env.YOUTUBE_API_KEY,
  probe: (ctx) =>
    guarded("youtube", async () => {
      const key = ctx.env.YOUTUBE_API_KEY;
      if (!key) return { source: "youtube", status: "missing", detail: "YOUTUBE_API_KEY not set", signals: [] };
      const base = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=50&q=${encodeURIComponent(ctx.term)}&key=${encodeURIComponent(key)}`;
      const d7 = daysAgo(ctx.now, 7).toISOString();
      const d35 = daysAgo(ctx.now, 35).toISOString();
      const [week, prior] = await Promise.all([
        getJson<SearchResp>(`${base}&publishedAfter=${d7}`, { fetchImpl: ctx.fetchImpl, cacheMs: 60 * 60000 }),
        getJson<SearchResp>(`${base}&publishedAfter=${d35}&publishedBefore=${d7}`, { fetchImpl: ctx.fetchImpl, cacheMs: 60 * 60000 }),
      ]);
      const weekly4 = r1(prior.pageInfo.totalResults / 4);
      const ch = change(week.pageInfo.totalResults, weekly4);
      const ids = week.items.map((i) => i.id.videoId).filter(Boolean).slice(0, 50);
      let views = 0;
      if (ids.length) {
        const v = await getJson<VideosResp>(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(",")}&key=${encodeURIComponent(key)}`, { fetchImpl: ctx.fetchImpl, cacheMs: 60 * 60000 });
        views = v.items.reduce((a, b) => a + Number(b.statistics.viewCount ?? 0), 0);
      }
      const top = week.items.slice(0, 5).map((i) => ({ title: i.snippet.title, channel: i.snippet.channelTitle, at: i.snippet.publishedAt.slice(0, 10) }));
      return {
        source: "youtube", status: "ok", signals: [{
          source: "youtube", metric: "videos_7d", value: week.pageInfo.totalResults, baseline: null, changeVs12m: null, asOf: dateStr(ctx.now),
          note: `${week.pageInfo.totalResults.toLocaleString("en-US")} YouTube videos on "${ctx.term}" in 7 days vs ${weekly4.toLocaleString("en-US")}/week over the prior 4 weeks (${pct(ch)}); top 50 have ${views.toLocaleString("en-US")} views (12-month base from stored history)`,
          detail: { prior_4w_weekly_avg: weekly4, change_vs_prior_4w: ch, top50_views: views, top },
        }],
      };
    }),
};
