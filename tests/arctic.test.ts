import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { ARCTIC, busiestPosts, ingestReddit, mentions, rumorDoc, termPattern, toRow } from "@/lib/sources/arctic";
import { reddit } from "@/lib/sources/reddit";
import * as store from "@/lib/scout/store";

const now = new Date("2026-11-20T15:00:00Z");
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("Reddit through Arctic Shift", () => {
  it("stores posts without removed text, and matches whole words and $TICKERS", () => {
    expect(toRow({ id: "a1", subreddit: "wallstreetbets", created_utc: utc("2026-11-20T14:00:00Z"), title: "NVDA calls", selftext: "[removed]", score: 5, num_comments: 9, permalink: "/r/wallstreetbets/comments/a1/x/" }))
      .toMatchObject({ id: "a1", sub: "wallstreetbets", at: "2026-11-20T14:00:00.000Z", body: "", comments: 9, url: "https://www.reddit.com/r/wallstreetbets/comments/a1/x/" });
    const re = (t: string) => new RegExp(termPattern(t).replace(/\[:alnum:\]/g, "A-Za-z0-9"), "i");
    expect(re("NVDA").test("buying $NVDA today")).toBe(true);
    expect(re("NVDA").test("NVDAX is a fund")).toBe(false);
    expect(re("home generator").test("Home  generator sales up")).toBe(true);
    expect(rumorDoc("conspiracy", "2026-11-19", [{ title: "They are hiding X", body: "details", comments: 50, url: "u" }])).toBe("where: r/conspiracy · date: 2026-11-19 · comments: 50 · link: u\n# They are hiding X\ndetails");
  });

  describe("the scout's copy (PGlite, fake Arctic Shift)", () => {
    let pg: PGlite;
    beforeAll(() => {
      pg = new PGlite();
      setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
      ARCTIC.gapMs = 0;
    });
    afterAll(() => { setQuerierForTests(null); ARCTIC.gapMs = 2500; });

    it("stores new posts and backfills older ones, then counts mentions for the Reddit source", async () => {
      const calls: string[] = [];
      const fake: typeof fetch = async (url) => {
        const u = new URL(String(url));
        calls.push(`${u.searchParams.get("subreddit")}:${u.searchParams.get("sort")}`);
        const sub = u.searchParams.get("subreddit")!;
        const posts = u.searchParams.get("sort") === "asc"
          ? (sub === "wallstreetbets" ? [{ id: "n1", subreddit: sub, created_utc: utc("2026-11-20T14:30:00Z"), title: "Generac to the moon", num_comments: 40 }] : [])
          : (sub === "wallstreetbets" ? [{ id: "o1", subreddit: sub, created_utc: utc("2026-11-02T12:00:00Z"), title: "generac earnings play", num_comments: 3 }] : []);
        return new Response(JSON.stringify({ data: posts }), { status: 200 });
      };
      // Nothing stored yet: the source says it is still collecting instead of counting.
      expect((await reddit.probe({ term: "generac", kind: "consumer", tickers: [], now, env: {} as NodeJS.ProcessEnv })).detail).toMatch(/collecting posts: 0 day/);
      expect(await ingestReddit(Date.now() + 60_000, fake, now)).toContain("wallstreetbets +1");
      expect(calls).toContain("wallstreetbets:asc");
      expect(calls).toContain("wallstreetbets:desc");
      // With the copy covering five weeks: counted against the weeks before.
      const floor = utc("2026-10-15T00:00:00Z");
      await store.cachePut("reddit:ingest", Object.fromEntries(ARCTIC.finance.map((s) => [s, { newest: utc("2026-11-20T14:30:00Z"), oldest: floor }])));
      const r = await reddit.probe({ term: "generac", kind: "consumer", tickers: [], now, env: {} as NodeJS.ProcessEnv });
      expect(r.status).toBe("ok");
      expect(r.signals[0]).toMatchObject({ metric: "posts_7d", value: 1 });
      expect(r.signals[0].note).toMatch(/^1 posts mentioning "generac" in 9 finance subreddits in 7 days vs 0.3\/week over the 28 days before/);
      expect((await mentions("generac", new Date("2026-10-01"), now)).n).toBe(2);
      expect((await busiestPosts(24 * 30))[0]).toMatchObject({ title: "Generac to the moon", comments: 40 });
    });
  });
});
