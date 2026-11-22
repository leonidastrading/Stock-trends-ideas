/** "New since you last looked" counts for the menu's badges. Each tab's count is what was added after the time it was last seen. */
import { query as q } from "../db";
import * as store from "./store";

export const BADGE_TABS = ["research", "bubbles", "stocktwits", "ideas", "news", "drift", "rumors", "themes", "investigate", "inbox", "filings", "congress", "watchlist"] as const;
export type BadgeTab = (typeof BADGE_TABS)[number];

const n = async (sql: string, since: string) => Number((await q(sql, [since]).catch(() => [{ n: 0 }]))[0]?.n ?? 0);

/** Pure-ish: count per tab of items newer than its `since` (capped at 100). Tabs without a time are skipped. */
export async function badgeCounts(since: Partial<Record<BadgeTab, string>>, now = new Date()): Promise<Partial<Record<BadgeTab, number>>> {
  const out: Partial<Record<BadgeTab, number>> = {};
  const ok = (t: BadgeTab) => { const s = since[t]; return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
  const jobs: Array<Promise<void>> = [];
  const add = (t: BadgeTab, f: (s: string) => Promise<number>) => { const s = ok(t); if (s) jobs.push(f(s).then((v) => { out[t] = Math.min(100, v); }).catch(() => undefined)); };
  // Shorts under $5 are not suggested, so they do not count as new ideas.
  add("ideas", (s) => n(`SELECT count(*) AS n FROM cards WHERE created_at > $1 AND NOT (direction = 'short' AND array_to_string(gate_notes, ' ') ~ 'under [$]5')`, s));
  add("rumors", async (s) => (await n(`SELECT count(*) AS n FROM rumors WHERE created_at > $1`, s)) + (await n(`SELECT count(DISTINCT rumor_id) AS n FROM rumor_checks WHERE status = 'confirmed' AND checked_at > $1`, s)));
  // Research you asked for that finished since you last looked (a card or a rejection).
  add("research", (s) => n(`SELECT count(*) AS n FROM research_requests WHERE finished_at > $1`, s));
  // Newly listed hype setups, only the loud ones (mania or building).
  add("bubbles", async (s) => (await n(`SELECT count(*) AS n FROM bubble_events WHERE first_seen > $1 AND level IN ('mania', 'building')`, s)) + (await n(`SELECT count(*) AS n FROM bubble_movers WHERE first_seen > $1`, s)));
  // A new trending snapshot (9 AM and 3 PM).
  add("stocktwits", (s) => n(`SELECT count(*) AS n FROM st_snapshots WHERE taken_at > $1`, s));
  add("themes", (s) => n(`SELECT count(*) AS n FROM theme_runs WHERE created_at > $1`, s));
  add("investigate", (s) => n(`SELECT count(*) AS n FROM investigations WHERE status = 'done' AND created_at > $1`, s));
  add("inbox", (s) => n(`SELECT count(*) AS n FROM inbox_files WHERE read_at > $1`, s));
  add("filings", async (s) => (await n(`SELECT count(*) AS n FROM insider_buys WHERE created_at > $1`, s)) + (await n(`SELECT count(*) AS n FROM filing_alerts WHERE created_at > $1`, s)));
  add("congress", (s) => n(`SELECT count(*) AS n FROM congress_trades WHERE created_at > $1`, s));
  add("watchlist", (s) => n(`SELECT count(*) AS n FROM watchlist WHERE added_at > $1`, s));
  add("drift", async (s) => {
    const earn = await n(`SELECT count(*) AS n FROM earnings_scans WHERE setup IS NOT NULL AND created_at > $1`, s);
    const seen = (await store.cacheGet<Record<string, string>>("drift:first-seen").catch(() => null))?.data ?? {};
    return earn + Object.values(seen).filter((at) => at > s).length;
  });
  // The News feed's shared copy (no extra calls): new headlines since the tab was last opened.
  add("news", async (s) => {
    // Only the top stories (big moves, events, your card stocks, pile-ups, Trump), not every headline.
    const { isTopStory, newsFeed } = await import("./newsfeed");
    return (await newsFeed(now)).filter((x) => isTopStory(x) && Date.parse(x.at) > Date.parse(s)).length;
  });
  await Promise.all(jobs);
  return out;
}
