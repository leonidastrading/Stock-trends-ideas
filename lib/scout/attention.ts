/**
 * Attention: is a story still building? Two free measures.
 *
 * - Coverage trend: the news stream's stories per day for a ticker (completed
 *   weekdays only; today's count is partial). "Building" = up three weekdays in
 *   a row, or the latest day up and at least 1.5x the days before it, with at
 *   least 4 stories that day.
 * - Public attention: daily Wikipedia page views of the people at the centre
 *   of a story and of the company, against the 30 days before the story. A
 *   stand-in for social-media intensity (Reddit pending), e.g. a CEO's page at
 *   10x normal and rising while the stock is flat.
 */
import { getJson } from "../http";
import { findArticle } from "../sources/wikipedia";
import { addDays, daysBetween } from "../time";

export const ATTENTION = { minStories: 4, risingDays: 3, jumpMultiple: 1.5, maxNames: 3 };

export interface CoverageTrend { days: Array<{ date: string; stories: number }>; building: boolean; risingDays: number; line: string }

/** Pure: coverage trend over completed days before `today`. */
export function coverageTrend(counts: Array<{ date: string; stories: number }>, today: string): CoverageTrend {
  const byDate = new Map<string, number>();
  for (const c of counts) if (c.date < today) byDate.set(c.date, Math.max(byDate.get(c.date) ?? 0, c.stories));
  // The last 5 weekdays before today (weekend news is thin for everyone, so a Monday would always look like a jump).
  const dates: string[] = [];
  for (let d = addDays(today, -1); dates.length < 5; d = addDays(d, -1)) if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) dates.unshift(d);
  const days = dates.map((date) => ({ date, stories: byDate.get(date) ?? 0 }));
  let rising = 0;
  for (let i = days.length - 1; i > 0 && days[i].stories > days[i - 1].stories; i--) rising++;
  const last = days[days.length - 1].stories;
  // The jump test needs counts on at least two of the three days before (missing days mean no scan ran, not no news).
  const prior = days.slice(-4, -1).filter((d) => byDate.has(d.date));
  const prev = prior.length >= 2 ? prior.reduce((a, d) => a + d.stories, 0) / prior.length : null;
  const growing = rising >= 1;
  const building = last >= ATTENTION.minStories && growing && (rising >= ATTENTION.risingDays || (prev !== null && last >= ATTENTION.jumpMultiple * prev));
  const line = `coverage ${days.slice(-4).map((d) => d.stories).join(" → ")} stories/day over the last 4 weekdays${building ? (rising >= ATTENTION.risingDays ? ` (up ${rising} days in a row: building)` : " (jumped: building)") : ""}`;
  return { days, building, risingDays: rising, line };
}

export interface Attention { name: string; article: string; latest: number; before: number | null; multiple: number | null; risingDays: number; line: string }

/** Pure: daily views (oldest first) → latest day vs the 30 days before `storyDate`, and the rising streak. */
export function summarizeViews(name: string, article: string, series: Array<{ date: string; views: number }>, storyDate: string): Attention | null {
  if (!series.length) return null;
  const latest = series[series.length - 1].views;
  const pre = series.filter((p) => p.date < storyDate && daysBetween(p.date, storyDate) <= 30);
  const before = pre.length >= 7 ? pre.reduce((a, p) => a + p.views, 0) / pre.length : null;
  let rising = 0;
  for (let i = series.length - 1; i > 0 && series[i].views > series[i - 1].views; i--) rising++;
  const multiple = before ? latest / before : null;
  const fmt = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));
  const line = `Wikipedia "${article}": ${fmt(latest)} views on ${series[series.length - 1].date}${before ? ` vs ${fmt(Math.round(before))}/day in the 30 days before the story (${multiple!.toFixed(1)}x)` : ""}${rising >= 2 ? `, rising ${rising} days in a row` : ""}`;
  return { name, article, latest, before: before === null ? null : Math.round(before), multiple: multiple === null ? null : Math.round(multiple * 10) / 10, risingDays: rising, line };
}

const UA = { "user-agent": "trend-scout/0.1 (research dashboard)" };

/** Daily Wikipedia views for each name (people, then the company) from 35 days before the story to yesterday. Never throws. */
export async function publicAttention(names: string[], storyDate: string, today: string, fetchImpl?: typeof fetch): Promise<Attention[]> {
  const out: Attention[] = [];
  const fmt = (d: string) => d.replace(/-/g, "");
  for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, ATTENTION.maxNames)) {
    try {
      const article = await findArticle(name, fetchImpl);
      if (!article) continue;
      const r = await getJson<{ items?: Array<{ timestamp: string; views: number }> }>(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article.replace(/ /g, "_"))}/daily/${fmt(addDays(storyDate, -35))}/${fmt(addDays(today, -1))}`,
        { headers: UA, fetchImpl, cacheMs: 6 * 60 * 60000 },
      );
      const series = (r.items ?? []).map((i) => ({ date: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`, views: i.views }));
      const a = summarizeViews(name, article, series, storyDate);
      if (a) out.push(a);
    } catch {
      /* attention is context, never a reason to fail */
    }
  }
  return out;
}
