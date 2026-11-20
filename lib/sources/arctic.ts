/**
 * Reddit through Arctic Shift (arctic-shift.photon-reddit.com), a public archive of Reddit that keeps up within a few
 * minutes. Reddit itself blocks servers (403) and stopped approving Data API access (November 2026). Arctic Shift
 * cannot search all of Reddit at once (every search names a subreddit) and its full-text search is slow, so the scout
 * keeps its own copy: every few minutes it stores the new posts from a set of finance subreddits (and r/conspiracy
 * for the Rumors tab), keeps 60 days, and backfills the last 35 days a little at a time. Mention counts, the Dots scan
 * and the daily Rumors read all come from that copy. Arctic Shift is a volunteer project: it asks callers to slow down
 * when busy, so requests are spaced out, and a failure leaves the copy as it was.
 */
import { query as q } from "../db";
import * as store from "../scout/store";

export const ARCTIC = {
  base: "https://arctic-shift.photon-reddit.com/api",
  /** Finance subreddits counted for mentions and read by Dots. */
  finance: ["wallstreetbets", "stocks", "investing", "StockMarket", "options", "pennystocks", "smallstreetbets", "ValueInvesting", "Daytrading"],
  /** Read once a day for the Rumors tab (the scout keeps only claims that could move a listed security). */
  rumors: ["conspiracy", "wallstreetbets"],
  keepDays: 60,
  backfillDays: 35,
  gapMs: 2500,
};

const UA = { "user-agent": "trend-scout research (Arctic Shift reader)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const allSubs = () => [...new Set([...ARCTIC.finance, ...ARCTIC.rumors])];

interface ArcticPost { id: string; subreddit: string; created_utc: number; title: string; selftext?: string; score?: number; num_comments?: number; permalink?: string; author?: string }

/** Pure: a post as stored (the text cut to 1,000 characters; removed and deleted text dropped). */
export function toRow(p: ArcticPost): { id: string; sub: string; at: string; title: string; body: string; score: number; comments: number; url: string } {
  const body = (p.selftext ?? "").trim();
  return {
    id: p.id, sub: p.subreddit, at: new Date(p.created_utc * 1000).toISOString(), title: (p.title ?? "").slice(0, 400),
    body: /^\[(removed|deleted)\]$/.test(body) ? "" : body.slice(0, 1000), score: p.score ?? 0, comments: p.num_comments ?? 0,
    url: p.permalink ? `https://www.reddit.com${p.permalink}` : `https://www.reddit.com/r/${p.subreddit}/comments/${p.id}/`,
  };
}

async function page(sub: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<ArcticPost[]> {
  const qs = new URLSearchParams({ subreddit: sub, limit: "auto", fields: "id,subreddit,created_utc,title,selftext,score,num_comments", ...params });
  const res = await fetchImpl(`${ARCTIC.base}/posts/search?${qs}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
  const j = (await res.json().catch(() => ({}))) as { data?: ArcticPost[]; error?: string };
  if (!res.ok || !Array.isArray(j.data)) throw new Error(`Arctic Shift ${res.status}${j.error ? `: ${j.error}` : ""}`);
  return j.data;
}

/** Store a page of posts in one statement (a page can hold a thousand). */
async function save(posts: ArcticPost[]): Promise<number> {
  if (!posts.length) return 0;
  const rows = posts.map(toRow);
  const ins = await q(
    `INSERT INTO reddit_posts (id, sub, created_at, title, body, score, comments, url)
     SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[])
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [rows.map((r) => r.id), rows.map((r) => r.sub.toLowerCase()), rows.map((r) => r.at), rows.map((r) => r.title), rows.map((r) => r.body), rows.map((r) => r.score), rows.map((r) => r.comments), rows.map((r) => r.url)],
  );
  return ins.length;
}

/**
 * Store what is new in each subreddit since the last call, then backfill older posts (one page per subreddit per call)
 * until 35 days are covered. Stops at the deadline; the next call goes on from there.
 */
export async function ingestReddit(deadline = Date.now() + 25_000, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<string> {
  if (!(await store.tryLock("lock:reddit-ingest", 3))) return "another ingest is running";
  const out: string[] = [];
  try {
    const state = (await store.cacheGet<Record<string, { newest: number; oldest: number }>>("reddit:ingest"))?.data ?? {};
    const floor = Math.floor(now.getTime() / 1000) - ARCTIC.backfillDays * 86400;
    for (const sub of allSubs()) {
      if (Date.now() > deadline) break;
      const s = state[sub] ?? { newest: Math.floor(now.getTime() / 1000) - 3600, oldest: Math.floor(now.getTime() / 1000) - 3600 };
      try {
        // New posts since the newest stored, oldest first (several pages when a lot happened).
        for (let i = 0; i < 5 && Date.now() < deadline; i++) {
          const posts = await page(sub, { after: String(s.newest + 1), sort: "asc" }, fetchImpl);
          await sleep(ARCTIC.gapMs);
          if (!posts.length) break;
          const added = await save(posts);
          s.newest = Math.max(s.newest, ...posts.map((p) => p.created_utc));
          out.push(`${sub} +${added}`);
          if (posts.length < 100) break;
        }
        // One page further back, in a 2-day window (a 35-day range times out on the archive), until 35 days are covered.
        if (s.oldest > floor && Date.now() < deadline) {
          const from = Math.max(floor, s.oldest - 2 * 86400);
          const older = await page(sub, { before: String(s.oldest), after: String(from), sort: "desc" }, fetchImpl);
          await sleep(ARCTIC.gapMs);
          if (older.length) await save(older);
          // A full page: more in this window, go on from its oldest post; otherwise the window is done.
          s.oldest = older.length >= 100 ? Math.min(s.oldest, ...older.map((p) => p.created_utc)) : from;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.push(`${sub}: ${msg.slice(0, 80)}`);
        state[sub] = s;
        // The archive is busy: stop for this call and leave it alone until the next one.
        if (/slow down|429|422/i.test(msg)) { out.push("stopped: the archive asked to slow down"); break; }
        await sleep(ARCTIC.gapMs * 2);
      }
      state[sub] = s;
      await store.cachePut("reddit:ingest", state);
    }
    await store.cachePut("reddit:ingest", state);
    await q(`DELETE FROM reddit_posts WHERE created_at < now() - ($1::int * interval '1 day')`, [ARCTIC.keepDays]);
  } finally {
    await store.unlock("lock:reddit-ingest").catch(() => undefined);
  }
  const days = await coverageDays(now).catch(() => 0);
  return `${out.join(", ") || "nothing new"} · ${days} of ${ARCTIC.backfillDays} days stored`;
}

/** How far back the stored copy reaches for the finance subreddits (days), the smallest across them. */
export async function coverageDays(now = new Date()): Promise<number> {
  const state = (await store.cacheGet<Record<string, { newest: number; oldest: number }>>("reddit:ingest"))?.data ?? {};
  const subs = ARCTIC.finance.map((s) => state[s]?.oldest).filter((x): x is number => !!x);
  if (subs.length < ARCTIC.finance.length) return 0;
  return Math.max(0, Math.floor((now.getTime() / 1000 - Math.max(...subs)) / 86400));
}

/** Pure: a term as a case-insensitive whole-word pattern for Postgres (a ticker also matches "$NVDA"). */
export function termPattern(term: string): string {
  const esc = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return `(^|[^[:alnum:]])\\$?${esc}([^[:alnum:]]|$)`;
}

/** Finance-subreddit posts mentioning a term (title or text) in a window, with the busiest few. */
export async function mentions(term: string, from: Date, to: Date): Promise<{ n: number; top: Array<{ title: string; sub: string; at: string; comments: number; url: string }> }> {
  const pat = termPattern(term);
  const subs = ARCTIC.finance.map((s) => s.toLowerCase());
  const n = Number((await q(`SELECT count(*) AS n FROM reddit_posts WHERE sub = ANY($1) AND created_at >= $2 AND created_at < $3 AND (title ~* $4 OR body ~* $4)`, [subs, from.toISOString(), to.toISOString(), pat]))[0].n);
  const top = (await q(`SELECT title, sub, created_at, comments, url FROM reddit_posts WHERE sub = ANY($1) AND created_at >= $2 AND created_at < $3 AND (title ~* $4 OR body ~* $4) ORDER BY comments DESC, created_at DESC LIMIT 5`, [subs, from.toISOString(), to.toISOString(), pat]))
    .map((r) => ({ title: String(r.title), sub: String(r.sub), at: new Date(r.created_at as string).toISOString().slice(0, 10), comments: Number(r.comments), url: String(r.url) }));
  return { n, top };
}

/** The most-discussed finance-subreddit posts in the last day (for the Dots scan). */
export async function busiestPosts(hours = 24, limit = 30): Promise<Array<{ title: string; sub: string; comments: number }>> {
  return (await q(`SELECT title, sub, comments FROM reddit_posts WHERE sub = ANY($1) AND created_at >= now() - ($2::int * interval '1 hour') ORDER BY comments DESC, score DESC LIMIT $3`, [ARCTIC.finance.map((s) => s.toLowerCase()), hours, limit]))
    .map((r) => ({ title: String(r.title), sub: String(r.sub), comments: Number(r.comments) }));
}

/** Pure: a day of a subreddit's posts as a document for the rumor reader (busiest first). */
export function rumorDoc(sub: string, day: string, posts: Array<{ title: string; body: string; comments: number; url: string }>): string {
  return posts.map((p) => `where: r/${sub} · date: ${day} · comments: ${p.comments} · link: ${p.url}\n# ${p.title}${p.body ? `\n${p.body}` : ""}`).join("\n\n---\n\n");
}

/** Once a day per subreddit: yesterday's posts from the rumor subreddits go to the Rumors tab (each day read once). */
export async function readRedditRumors(deps: Parameters<typeof import("../scout/rumors").readRumorDoc>[2], day: string): Promise<string> {
  const { readRumorDoc } = await import("../scout/rumors");
  const out: string[] = [];
  for (const sub of ARCTIC.rumors) {
    const path = `reddit:${sub.toLowerCase()}:${day}`;
    if ((await q(`SELECT 1 FROM rumor_docs WHERE path = $1`, [path])).length) continue;
    const posts = (await q(`SELECT title, body, comments, url FROM reddit_posts WHERE sub = $1 AND created_at >= $2::date AND created_at < $2::date + interval '1 day' ORDER BY comments DESC LIMIT 60`, [sub.toLowerCase(), day]))
      .map((r) => ({ title: String(r.title), body: String(r.body ?? ""), comments: Number(r.comments), url: String(r.url) }));
    if (posts.length < 5) continue; // the copy does not reach that day yet
    const r = await readRumorDoc(rumorDoc(sub, day, posts), `Reddit r/${sub}, ${day} (${posts.length} busiest posts)`, deps, path);
    out.push(`r/${sub}: ${r.rumors} rumors${r.error ? ` (${r.error})` : ""}`);
  }
  return out.join("; ") || "nothing to read";
}
