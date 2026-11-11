/** Wikipedia pageviews: last 7 days' average views against the trailing 12-month average. Free, no key. */
import { getJson } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Source } from "./types";

const UA = { "user-agent": "trend-scout/0.1 (research dashboard)" };

export async function findArticle(term: string, fetchImpl?: typeof fetch): Promise<string | null> {
  const r = await getJson<{ query?: { search?: Array<{ title: string }> } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=${encodeURIComponent(term)}`,
    { headers: UA, fetchImpl },
  );
  return r.query?.search?.[0]?.title ?? null;
}

/** Pure: 7-day average vs 365-day average from a daily series (oldest first). */
export function pageviewSummary(views: Array<{ date: string; views: number }>) {
  if (views.length < 14) return null;
  const last7 = views.slice(-7);
  const all = views;
  const v7 = last7.reduce((a, b) => a + b.views, 0) / last7.length;
  const v365 = all.reduce((a, b) => a + b.views, 0) / all.length;
  return { v7: r1(v7), v365: r1(v365), asOf: last7[last7.length - 1].date };
}

export const wikipedia: Source = {
  id: "wikipedia",
  label: "Wikipedia pageviews",
  about: "Page-view acceleration for the term's article (7-day average vs 12-month average).",
  configured: () => true,
  probe: (ctx) =>
    guarded("wikipedia", async () => {
      const title = await findArticle(ctx.term, ctx.fetchImpl);
      if (!title) return { source: "wikipedia", status: "ok", detail: `no article for "${ctx.term}"`, signals: [] };
      const end = daysAgo(ctx.now, 1);
      const start = daysAgo(ctx.now, 366);
      const fmt = (d: Date) => dateStr(d).replace(/-/g, "");
      const r = await getJson<{ items?: Array<{ timestamp: string; views: number }> }>(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/daily/${fmt(start)}/${fmt(end)}`,
        { headers: UA, fetchImpl: ctx.fetchImpl },
      );
      const series = (r.items ?? []).map((i) => ({ date: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`, views: i.views }));
      const s = pageviewSummary(series);
      if (!s) return { source: "wikipedia", status: "ok", detail: `too little history for "${title}"`, signals: [] };
      const ch = change(s.v7, s.v365);
      return {
        source: "wikipedia", status: "ok", signals: [{
          source: "wikipedia", metric: "pageviews_per_day_7d", value: s.v7, baseline: s.v365, changeVs12m: ch, asOf: s.asOf,
          note: `"${title}": ${s.v7.toLocaleString("en-US")} views/day over the last 7 days vs ${s.v365.toLocaleString("en-US")} over 12 months (${pct(ch)})`,
          detail: { article: title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` },
        }],
      };
    }),
};
