/**
 * Google Trends has no official API. This uses the public explore/multiline
 * endpoints the website itself calls (12-month weekly interest, 0–100) and the
 * public "trending now" RSS feed for rising queries. Google rate-limits these
 * hard; a 429 is reported as "down", not treated as a zero.
 */
import { getText } from "../http";
import { change, dateStr, guarded, pct, r1, type Source } from "./types";

const UA = { "user-agent": "Mozilla/5.0 (compatible; trend-scout/0.1)", accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9" };
const strip = (s: string) => JSON.parse(s.replace(/^\)\]\}',?\s*/, ""));

/** Google answers the API endpoints far more often when the request carries the NID cookie the site sets on a first visit. */
let cookie: string | null = null;
async function headers(fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  if (cookie === null) {
    try {
      const res = await fetchImpl("https://trends.google.com/trends/explore?geo=US&hl=en-US", { headers: UA, redirect: "manual" });
      const set = res.headers.get("set-cookie") ?? "";
      cookie = /NID=[^;]+/.exec(set)?.[0] ?? "";
    } catch {
      cookie = "";
    }
  }
  return cookie ? { ...UA, cookie } : UA;
}

/** Pure: last 4 weekly points vs the 12-month average from a 0–100 timeline. */
export function interestSummary(points: Array<{ date: string; value: number }>) {
  if (points.length < 8) return null;
  const last4 = points.slice(-4);
  const v4 = last4.reduce((a, b) => a + b.value, 0) / last4.length;
  const v52 = points.reduce((a, b) => a + b.value, 0) / points.length;
  return { v4: r1(v4), v52: r1(v52), peak: Math.max(...points.map((p) => p.value)), asOf: last4[last4.length - 1].date };
}

export async function interestOverTime(term: string, fetchImpl?: typeof fetch): Promise<Array<{ date: string; value: number }>> {
  const req = JSON.stringify({ comparisonItem: [{ keyword: term, geo: "US", time: "today 12-m" }], category: 0, property: "" });
  const h = await headers(fetchImpl);
  const explore = strip(await getText(`https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(req)}`, { headers: h, minIntervalMs: 3000, fetchImpl, retries: 1 }));
  const w = (explore.widgets as Array<{ id: string; token: string; request: unknown }>).find((x) => x.id === "TIMESERIES");
  if (!w) throw new Error("no TIMESERIES widget");
  const data = strip(await getText(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${encodeURIComponent(w.token)}`, { headers: h, minIntervalMs: 3000, fetchImpl, retries: 1 }));
  return (data.default.timelineData as Array<{ formattedAxisTime: string; time: string; value: number[] }>).map((p) => ({ date: new Date(Number(p.time) * 1000).toISOString().slice(0, 10), value: p.value[0] }));
}

/** Rising queries from the public trending-now feed (for watch-list proposals). */
export async function trendingNow(fetchImpl?: typeof fetch): Promise<Array<{ title: string; traffic: string }>> {
  const xml = await getText("https://trends.google.com/trending/rss?geo=US", { headers: UA, minIntervalMs: 2000, fetchImpl, retries: 1, cacheMs: 6 * 60 * 60000 });
  const out: Array<{ title: string; traffic: string }> = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = /<title>(?:<!\[CDATA\[)?([^<\]]+)/.exec(m[1])?.[1]?.trim();
    const traffic = /approx_traffic>(?:<!\[CDATA\[)?([^<\]]+)/.exec(m[1])?.[1]?.trim() ?? "";
    if (title) out.push({ title, traffic });
  }
  return out;
}

export const googleTrends: Source = {
  id: "google_trends",
  label: "Google Trends",
  about: "12-month search interest curve (0–100) for the term; rising queries for watch-list proposals.",
  configured: () => true,
  probe: (ctx) =>
    guarded("google_trends", async () => {
      const points = await interestOverTime(ctx.term, ctx.fetchImpl);
      const s = interestSummary(points);
      if (!s) return { source: "google_trends", status: "ok", detail: "not enough search volume", signals: [] };
      const ch = change(s.v4, s.v52);
      return {
        source: "google_trends", status: "ok", signals: [{
          source: "google_trends", metric: "search_interest_4w", value: s.v4, baseline: s.v52, changeVs12m: ch, asOf: s.asOf,
          note: `Google search interest for "${ctx.term}" (US): ${s.v4} over the last 4 weeks vs ${s.v52} average over 12 months (${pct(ch)}; 12-month peak = ${s.peak})`,
          detail: { last_12_weeks: points.slice(-12) },
        }],
      };
    }),
};
