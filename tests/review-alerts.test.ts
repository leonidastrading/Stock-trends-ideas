import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData } from "@/lib/alpaca";
import { query, setQuerierForTests } from "@/lib/db";
import { cardPushes, pushNewCards, pushReviews } from "@/lib/scout/alerts";
import type { CallModel } from "@/lib/scout/llm";
import { directionalMove, dueForReview, parseReview, REVIEW_JSON_SCHEMA, runReviews } from "@/lib/scout/review";
import * as store from "@/lib/scout/store";
import { sampleCard } from "./card.test";

let pg: PGlite;
beforeAll(() => {
  pg = new PGlite();
  setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
});
afterAll(() => setQuerierForTests(null));

const env = { NTFY_TOPIC: "trendscout-test", DASHBOARD_URL: "https://scout.example" } as unknown as NodeJS.ProcessEnv;
const pushes: Array<Record<string, unknown>> = [];
const ntfy: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  expect(String(url)).toBe("https://ntfy.sh");
  pushes.push(JSON.parse(String(init?.body)));
  return new Response("{}", { status: 200 });
}) as typeof fetch;

describe("post-catalyst review", () => {
  it("pure parts", () => {
    expect(directionalMove("short", 100, 90)).toBe(10);
    expect(directionalMove("long", 100, 90)).toBe(-10);
    expect(directionalMove("long", null, 90)).toBeNull();
    expect(JSON.stringify(REVIEW_JSON_SCHEMA)).not.toMatch(/"(minItems|maxItems|minimum|maximum|pattern)":/);
    expect(parseReview(JSON.stringify({ verdict: "mixed", summary: "s", evidence: [1, 2, 3, 4].map((i) => ({ date: "d", source: "s", headline: `h${i}` })) })).evidence).toHaveLength(3);
    expect(() => parseReview(JSON.stringify({ verdict: "great", summary: "s", evidence: [] }))).toThrow(/verdict/);
  });

  it("reviews a card the day after its catalyst, once, and pushes the verdict once", async () => {
    const v = await store.ensureVersion("h", "m", "high", {});
    const card = await store.insertCard({ versionId: v.id, origin: "scout", card: sampleCard({ catalyst: { what: "Q4 results", date: "2026-11-17" } }), model: "m", modelServed: null, prompt: "", replyText: "", usage: null, costUsd: null, status: "promoted", gateNotes: [], catalystDate: "2026-11-17", rankScore: 56 });
    await store.insertTrack({ cardId: card.id, symbol: "HUBB", sectorEtf: "XLI", direction: "long", cardDate: "2026-11-13", deadlineDate: "2026-11-18" });
    await store.setEntry(card.id, { entryDate: "2026-11-16", entryPrice: 100, spyEntry: 600, sectorEntry: 100 });
    await store.upsertBars([
      { symbol: "HUBB", date: "2026-11-17", o: 101, h: 102, l: 100, c: 102, v: 1 }, { symbol: "HUBB", date: "2026-11-18", o: 108, h: 111, l: 107, c: 110, v: 1 },
      { symbol: "SPY", date: "2026-11-17", o: 600, h: 600, l: 600, c: 600, v: 1 }, { symbol: "SPY", date: "2026-11-18", o: 606, h: 606, l: 606, c: 606, v: 1 },
    ]);
    const data = { getNews: async () => [{ id: 1, ts: "2026-11-18T12:00:00Z", headline: "Hubbell beats, raises guidance on grid demand", summary: "", symbols: ["HUBB"], source: "benzinga", url: "" }], getDailyBars: async () => [], getCalendar: async () => [] } as MarketData;
    const prompts: string[] = [];
    const callModel: CallModel = async ({ user, purpose }) => {
      expect(purpose).toBe("review");
      prompts.push(user);
      return { text: JSON.stringify({ verdict: "played_out", summary: "Beat and raise on Nov 17; stock +7.8% next day.", evidence: [{ date: "2026-11-18", source: "benzinga", headline: "Hubbell beats" }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.002 };
    };
    expect(dueForReview([card], await store.allTracks(), new Set(), "2026-11-17")).toHaveLength(0); // not the day after yet
    const r = await runReviews({ data, callModel, now: new Date("2026-11-18T22:30:00Z") });
    expect(r).toEqual([{ cardId: card.id, verdict: "played_out" }]);
    expect(prompts[0]).toMatch(/move for the trade since entry: 10%/);
    expect(prompts[0]).toMatch(/move for the trade since then: 7.8%/);
    expect(prompts[0]).toMatch(/SPY over the same window since the catalyst: 1%/);
    expect(prompts[0]).toMatch(/Hubbell beats, raises guidance/);
    expect(await runReviews({ data, callModel, now: new Date("2026-11-19T22:30:00Z") })).toEqual([]); // once only
    await expect(query(`DELETE FROM catalyst_reviews`)).rejects.toThrow(/append-only/);

    expect(await pushReviews(r, env, ntfy)).toBe(1);
    expect(await pushReviews(r, env, ntfy)).toBe(0);
    expect(pushes.at(-1)).toMatchObject({ topic: "trendscout-test", title: "▲ HUBB after the catalyst: played out", tags: ["white_check_mark"], click: `https://scout.example/candidates?days=30#card-${card.id}` });
    expect(String(pushes.at(-1)!.message)).toMatch(/Trade since entry: \+10%/);
  });

  it("pushes new promoted cards once; bundles more than three", async () => {
    const before = pushes.length;
    expect(await pushNewCards(env, ntfy)).toBe(1); // the promoted card from the test above
    expect(await pushNewCards(env, ntfy)).toBe(0);
    expect(pushes.length).toBe(before + 1);
    expect(pushes.at(-1)).toMatchObject({ title: "▲ HUBB · promoted", priority: 4 });
    expect(await pushNewCards({} as NodeJS.ProcessEnv, ntfy)).toBe(0); // not configured: nothing sent
    const c = (await store.allCards())[0];
    const many = Array.from({ length: 4 }, (_, i) => ({ ...c, id: i + 100, story: i % 2 === 0 }));
    const p = cardPushes(many, env);
    expect(p).toHaveLength(1);
    expect(p[0].title).toBe("Trend scout: 4 new trade cards");
  });
});
