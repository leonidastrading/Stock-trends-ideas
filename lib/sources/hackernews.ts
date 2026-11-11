/** Hacker News (Algolia API): stories mentioning the term, last 7 days vs the weekly average over 12 months. Free. */
import { getJson } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Source } from "./types";

interface Hits { nbHits: number; hits: Array<{ title: string; url?: string; points: number; num_comments: number; created_at: string }> }

export const hackerNews: Source = {
  id: "hacker_news",
  label: "Hacker News",
  about: "Story counts for technology and infrastructure themes (7 days vs the 12-month weekly average).",
  configured: () => true,
  probe: (ctx) =>
    guarded("hacker_news", async () => {
      const q = encodeURIComponent(ctx.term);
      const t7 = Math.floor(daysAgo(ctx.now, 7).getTime() / 1000);
      const t365 = Math.floor(daysAgo(ctx.now, 365).getTime() / 1000);
      const base = "https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=10";
      const [week, year] = await Promise.all([
        getJson<Hits>(`${base}&query=${q}&numericFilters=created_at_i>${t7}`, { fetchImpl: ctx.fetchImpl }),
        getJson<Hits>(`${base}&query=${q}&numericFilters=created_at_i>${t365}`, { fetchImpl: ctx.fetchImpl }),
      ]);
      const weekly12m = r1(year.nbHits / 52);
      const ch = change(week.nbHits, weekly12m);
      const top = week.hits.slice(0, 5).map((h) => ({ title: h.title, points: h.points, comments: h.num_comments, url: h.url, at: h.created_at.slice(0, 10) }));
      return {
        source: "hacker_news", status: "ok", signals: [{
          source: "hacker_news", metric: "stories_7d", value: week.nbHits, baseline: weekly12m, changeVs12m: ch, asOf: dateStr(ctx.now),
          note: `${week.nbHits} HN stories in 7 days vs ${weekly12m}/week over 12 months (${pct(ch)})`, detail: { top },
        }],
      };
    }),
};
