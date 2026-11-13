import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, setQuerierForTests } from "@/lib/db";
import { buildTriagePrompt } from "@/lib/scout/discovery";
import { preferencesText } from "@/lib/scout/preferences";
import * as store from "@/lib/scout/store";
import { buildStoryPrompt } from "@/lib/scout/stories";
import { sampleCard } from "./card.test";

let pg: PGlite;
beforeAll(() => {
  pg = new PGlite();
  setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
});
afterAll(() => setQuerierForTests(null));

describe("feedback", () => {
  it("is append-only, the latest vote per target counts, and it reaches the prompts", async () => {
    const v = await store.ensureVersion("h", "m", "high", {});
    const card = await store.insertCard({ versionId: v.id, origin: "scout", card: sampleCard(), model: "m", modelServed: null, prompt: "", replyText: "", usage: null, costUsd: null, status: "promoted", gateNotes: [], catalystDate: null, rankScore: 56 });
    await store.addFeedback(`card:${card.id}`, "down", null);
    await store.addFeedback(`card:${card.id}`, "up", "more supply-chain plays like this");
    await store.addFeedback("story:NVDA", "down", "CEO gossip, not a trade");
    await expect(query(`DELETE FROM feedback`)).rejects.toThrow(/append-only/);
    const latest = await store.latestFeedback();
    expect(latest.get(`card:${card.id}`)?.vote).toBe("up");
    const recent = await store.recentFeedback();
    expect(recent.map((f) => f.about)).toEqual(["story NVDA", "Transformer backlog pulls forward grid capex [second_order, long HUBB]"]);
    const text = preferencesText(recent)!;
    expect(text).toMatch(/Liked:\n- Transformer backlog .* — "more supply-chain plays like this"/);
    expect(text).toMatch(/Did not like:\n- story NVDA — "CEO gossip, not a trade"/);
    expect(preferencesText([])).toBeNull();
    expect(buildTriagePrompt({ date: "2026-11-13", headlinesRead: 0, topTickers: [], supplyDemand: [], stocktwits: [], polymarket: [], hackerNews: [], risingQueries: [], problems: [] }, 3, [], text)).toMatch(/Vadim's reactions/);
    expect(buildStoryPrompt([], "2026-11-13", text)).toMatch(/Did not like/);
  });
});
