import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { clearHttpCache } from "@/lib/http";
import { oddsMovers } from "@/lib/market/panels";
import type { CallModel } from "@/lib/scout/llm";
import { playerOf } from "@/lib/scout/scoreboard";
import * as store from "@/lib/scout/store";
import { parseTruthReply, pollTruth } from "@/lib/scout/truth";
import { mightMoveMarkets, parseTruthFeed } from "@/lib/sources/truth";

// The trumpstruth.org feed's shape (2026-11-14).
const item = (id: number, date: string, text: string) => `<item><title>Donald J. Trump</title><link>https://www.trumpstruth.org/statuses/${id}</link><guid>https://www.trumpstruth.org/statuses/${id}</guid><pubDate>${date}</pubDate><description><![CDATA[<p>${text}</p>]]></description></item>`;
const FEED = `<?xml version="1.0"?><rss><channel><title>Trump's Truth</title>
${item(43581, "Sat, 14 Nov 2026 22:00:23 +0000", "Some of the people that Gavin Newscum freed from the Death Penalty &amp; more")}
${item(43580, "Sat, 14 Nov 2026 19:35:21 +0000", "RT: https://truthsocial.com/users/realDonaldTrump/statuses/1176 Trash Island is the Worst Golf Course")}
${item(43582, "Sat, 14 Nov 2026 23:10:00 +0000", "Starting December 1st, a 50% TARIFF on all semiconductors made in Taiwan. Build them in the USA!")}
</channel></rss>`;

describe("Trump's posts", () => {
  it("reads the archive feed, newest first, with reposts marked", () => {
    const p = parseTruthFeed(FEED);
    expect(p.map((x) => x.id)).toEqual(["43582", "43581", "43580"]);
    expect(p[0]).toMatchObject({ url: "https://www.trumpstruth.org/statuses/43582", at: "2026-11-14T23:10:00.000Z", repost: false });
    expect(p[1].text).toBe("Some of the people that Gavin Newscum freed from the Death Penalty & more");
    expect(p[2].repost).toBe(true);
  });

  it("a wide keyword net picks what the model should judge", () => {
    expect(mightMoveMarkets("a 50% TARIFF on all semiconductors made in Taiwan")).toBe(true);
    expect(mightMoveMarkets("Trash Island is the Worst Golf Course")).toBe(false);
  });

  it("the model's reads are cleaned up", () => {
    const r = parseTruthReply(JSON.stringify({ posts: [{ id: "1", relevant: true, tickers: ["$tsm", "NVDA", "not a ticker!"], sectors: ["chips"], direction: "down", summary: "s", urgency: 5 }, { id: 2 }] }));
    expect([...r.keys()]).toEqual(["1"]);
    expect(r.get("1")!.tickers).toEqual(["TSM", "NVDA"]);
    expect(playerOf("scout", "truth: Chip tariff on Taiwan")).toBe("scout_truth");
  });

  it("Polymarket: big odds moves first, then volume", () => {
    const m = (question: string, yes: number, day: number, week: number, vol: number) => ({ question, outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), oneDayPriceChange: day, oneWeekPriceChange: week, volume24hr: vol });
    const r = oddsMovers([m("Busy, quiet", 0.5, 0, 0.01, 9e6), m("Fed cut in December?", 0.3, -0.12, -0.2, 1e6), m("Tariff deal by Jan?", 0.6, 0.02, 0.08, 2e6)]);
    expect(r.map((x) => x.question)).toEqual(["Fed cut in December?", "Tariff deal by Jan?", "Busy, quiet"]);
    expect(r[0]).toMatchObject({ yes: 30, dayChange: -12, weekChange: -20 });
  });
});

describe("pollTruth (PGlite, fake feed and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("judges only new posts that might matter, stores all of them once, and skips research when told", async () => {
    clearHttpCache();
    const fake = (async () => new Response(FEED, { status: 200 })) as unknown as typeof fetch;
    const judged: string[] = [];
    const callModel: CallModel = async ({ user, purpose }) => {
      judged.push(`${purpose}: ${user}`);
      return { text: JSON.stringify({ posts: [{ id: "43582", relevant: true, tickers: ["TSM", "NVDA"], sectors: ["semiconductors"], direction: "down", summary: "New 50% tariff on Taiwan-made chips from Dec 1.", urgency: 5 }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const deps = { data: null, sources: [], callModel, now: new Date("2026-11-15T00:00:00Z"), env: {} as NodeJS.ProcessEnv };
    const r = await pollTruth(deps, fake, { research: false });
    expect(r).toEqual({ fresh: 3, judged: 1, relevant: 1, pushed: 0, research: [] });
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatch(/^truth: [\s\S]*=== id 43582 · posted 2026-11-14T23:10:00.000Z ===\nStarting December 1st/);
    expect(judged[0]).not.toMatch(/Golf/);
    const stored = await store.truthPostsSince("2026-11-01T00:00:00Z", true);
    expect(stored.map((p) => [p.id, p.read?.urgency])).toEqual([["43582", 5]]);
    expect((await store.truthPostsSince("2026-11-01T00:00:00Z")).length).toBe(3);
    clearHttpCache();
    expect(await pollTruth(deps, fake, { research: false })).toEqual({ fresh: 0, judged: 0, relevant: 0, pushed: 0, research: [] });
    await expect(pg.query("DELETE FROM truth_posts")).rejects.toThrow(/append-only/);
  });
});
