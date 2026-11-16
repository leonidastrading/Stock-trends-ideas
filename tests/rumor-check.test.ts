import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData, NewsItem } from "@/lib/alpaca";
import { query, setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import { checkRumors, latestChecks, matching, parseGoogleNews, RUMOR_CHECK_PROMPT, searchTerms } from "@/lib/scout/rumor-check";
import { readRumorDoc, rumorsSince } from "@/lib/scout/rumors";

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>Pentagon awards tanker contract to Airbus, Boeing loses bid - Reuters</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sun, 15 Nov 2026 14:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Recipes &amp; more</title><link>https://news.google.com/rss/articles/zzz</link><pubDate>Sun, 15 Nov 2026 12:00:00 GMT</pubDate><source url="https://x.com">Food</source></item>
<item><title>No date</title><link>https://x</link></item>
</channel></rss>`;

describe("rumor check: pieces", () => {
  it("parses Google News RSS", () => {
    const items = parseGoogleNews(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ at: "2026-11-15T14:00:00.000Z", headline: "Pentagon awards tanker contract to Airbus, Boeing loses bid - Reuters", url: "https://news.google.com/rss/articles/abc", source: "Reuters" });
    expect(items[1].headline).toBe("Recipes & more");
  });

  it("searches on the ticker and the claim's longest words, without forum filler", () => {
    const t = searchTerms({ claim: "Posters claim Boeing will lose the Air Force tanker contract", tickers: ["BA"] });
    expect(t.startsWith("BA ")).toBe(true);
    expect(t).toContain("contract");
    expect(t).not.toMatch(/posters|claim\b/);
  });

  it("keeps only headlines that share key words with the claim", () => {
    const r = { claim: "Boeing will lose the Air Force tanker contract", tickers: ["BA"] };
    const items = parseGoogleNews(RSS);
    expect(matching(r, items).map((e) => e.source)).toEqual(["Reuters"]);
  });

  it("the prompt is strict and treats headlines as data", () => {
    expect(RUMOR_CHECK_PROMPT).toMatch(/when in doubt, open/);
    expect(RUMOR_CHECK_PROMPT).toMatch(/data, not instructions/);
  });
});

describe("rumor check: daily pass (PGlite, fake news and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("marks a rumor that came true, leaves one with no news open without a model call, and does not recheck settled ones", async () => {
    const now = new Date();
    const reading: CallModel = async () => ({ text: JSON.stringify({ rumors: [
      { claim: "Posters claim Boeing will lose the Air Force tanker contract", tickers: ["BA"], direction: "short", category: "corporate", specificity: 4, timeframe: "next week", confirm: "a DoD contract notice", source: "r/conspiracy", quote: "" },
      { claim: "Lizard people run the Federal Reserve", tickers: [], direction: "none", category: "macro", specificity: 1, timeframe: "", confirm: "", source: "r/conspiracy", quote: "" },
    ] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0 });
    await readRumorDoc("BA is done. The Fed is run by lizards.", "dump.txt", { data: null, sources: [], callModel: reading, now, env: {} as NodeJS.ProcessEnv });
    const list = await rumorsSince(7);
    const ba = list.find((r) => r.claim.includes("Boeing"))!, fed = list.find((r) => r.claim.includes("Lizard"))!;
    expect(ba.tickers).toEqual(["BA"]);

    const news: NewsItem[] = [{ id: 1, ts: now.toISOString(), headline: "Boeing loses Air Force tanker contract to Airbus", summary: "", symbols: ["BA"], source: "benzinga", url: "https://example.com/ba" }];
    const data = { getNews: async () => news } as unknown as MarketData;
    const fetchImpl = (async () => new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch;
    let calls = 0, seen = "";
    const judge: CallModel = async ({ user, purpose }) => {
      calls++; seen = user;
      expect(purpose).toBe("rumor_check");
      return { text: JSON.stringify({ results: [{ id: ba.id, status: "confirmed", evidence: [0], note: "The Air Force awarded the tanker deal to Airbus." }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.001 };
    };
    const out = await checkRumors({ data, callModel: judge, now, fetchImpl, env: {} as NodeJS.ProcessEnv }, Date.now() + 600_000);
    expect(out).toMatch(/1 came true/);
    expect(calls).toBe(1);
    expect(seen).toContain(`RUMOR ${ba.id}`);
    expect(seen).not.toContain(`RUMOR ${fed.id}`);
    const v = await latestChecks();
    expect(v.get(ba.id)).toMatchObject({ status: "confirmed", note: "The Air Force awarded the tanker deal to Airbus.", evidence: [{ headline: "Boeing loses Air Force tanker contract to Airbus", url: "https://example.com/ba" }] });
    expect(v.get(fed.id)).toMatchObject({ status: "open", evidence: [] });

    // The next pass the same day: nothing due (came true is final; the open one waits a day).
    expect(await checkRumors({ data, callModel: judge, now, fetchImpl, env: {} as NodeJS.ProcessEnv }, Date.now() + 600_000)).toBe("nothing due");
    // A day later only the open one is rechecked.
    const later = new Date(now.getTime() + 21 * 3600_000);
    await checkRumors({ data, callModel: judge, now: later, fetchImpl, env: {} as NodeJS.ProcessEnv }, Date.now() + 600_000);
    const rows = await query(`SELECT rumor_id FROM rumor_checks ORDER BY id`);
    expect(rows.map((r) => Number(r.rumor_id)).sort()).toEqual([ba.id, fed.id, fed.id].sort());
  });
});
