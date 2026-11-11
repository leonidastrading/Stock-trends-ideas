/**
 * Reddit: posts mentioning the term across all subreddits, last 7 days vs the
 * weekly average of the prior month (the public search API reaches back one
 * month at most; the 12-month base comes from the scout's own stored history
 * once it has one). Uses OAuth (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET) when
 * set, otherwise the public JSON endpoints at their lower rate limit.
 */
import { getJson } from "../http";
import { change, dateStr, guarded, pct, r1, type Source } from "./types";

const UA = "web:trend-scout:0.1 (research dashboard)";
let token: { value: string; exp: number } | null = null;

async function auth(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const id = env.REDDIT_CLIENT_ID;
  const secret = env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return { "user-agent": UA };
  if (!token || token.exp < Date.now()) {
    const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`reddit auth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  }
  return { authorization: `Bearer ${token.value}`, "user-agent": UA };
}

interface Listing { data: { children: Array<{ data: { title: string; subreddit: string; score: number; num_comments: number; created_utc: number; permalink: string } }>; after: string | null } }

/** Count posts in a window, paging up to `maxPages` (the public API caps at 100 per page). */
async function count(term: string, t: "week" | "month", headers: Record<string, string>, host: string, fetchImpl?: typeof fetch, maxPages = 3) {
  let n = 0;
  let after: string | null = null;
  const top: Array<{ title: string; subreddit: string; score: number; at: string }> = [];
  for (let p = 0; p < maxPages; p++) {
    const url: string = `${host}/search.json?q=${encodeURIComponent(`"${term}"`)}&sort=new&t=${t}&limit=100&raw_json=1${after ? `&after=${after}` : ""}`;
    const l: Listing = await getJson<Listing>(url, { headers, minIntervalMs: 1100, fetchImpl });
    const kids = l.data?.children ?? [];
    n += kids.length;
    if (p === 0) for (const k of kids.slice(0, 5)) top.push({ title: k.data.title, subreddit: k.data.subreddit, score: k.data.score, at: new Date(k.data.created_utc * 1000).toISOString().slice(0, 10) });
    after = l.data?.after ?? null;
    if (!after || kids.length < 100) return { n, top, capped: false };
  }
  return { n, top, capped: true };
}

export const reddit: Source = {
  id: "reddit",
  label: "Reddit",
  about: "Mention counts across subreddits; growth from a low base, not rank.",
  configured: () => true,
  probe: (ctx) =>
    guarded("reddit", async () => {
      const headers = await auth(ctx.env, ctx.fetchImpl);
      const host = headers.authorization ? "https://oauth.reddit.com" : "https://www.reddit.com";
      const week = await count(ctx.term, "week", headers, host, ctx.fetchImpl);
      const month = await count(ctx.term, "month", headers, host, ctx.fetchImpl);
      const weeklyBase = r1(month.n / 4.35);
      const ch = change(week.n, weeklyBase);
      const capped = week.capped || month.capped;
      return {
        source: "reddit", status: capped ? "capped" : "ok", detail: capped ? "search pages exhausted; counts are lower bounds" : undefined,
        signals: [{
          source: "reddit", metric: "posts_7d", value: week.n, baseline: null, changeVs12m: null, asOf: dateStr(ctx.now),
          note: `${week.n}${week.capped ? "+" : ""} Reddit posts mentioning "${ctx.term}" in 7 days vs ${weeklyBase}/week over the prior month (${pct(ch)}; 12-month base from stored history)`,
          detail: { month_posts: month.n, weekly_avg_prior_month: weeklyBase, change_vs_prior_month: ch, top: week.top },
        }],
      };
    }),
};
