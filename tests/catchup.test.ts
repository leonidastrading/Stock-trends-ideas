import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import * as store from "@/lib/scout/store";
import { drainQueue, enqueue, queueRows } from "@/lib/scout/catchup";
import { researchCandidate } from "@/lib/scout/research";

const emptyRss: typeof fetch = async () => new Response("<rss></rss>", { status: 200 });

describe("nothing is skipped when the daily AI budget runs out (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  const day1 = new Date("2026-11-19T20:00:00Z"); // 3 PM ET
  const day2 = new Date("2026-11-20T13:00:00Z"); // 8 AM ET, after the reset

  it("an idea the cap turns away is queued, and does not count as tried", async () => {
    const settings = await store.loadSettings();
    await store.logLlmCall({ etDate: "2026-11-19", model: settings.model, purpose: "research", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: settings.dailyCapUsd + 1, ok: true });
    const never: CallModel = async () => { throw new Error("the model must not be called over the cap"); };
    const r = await researchCandidate({ origin: "scout", term: "insider: ACME CEO buys", kindHint: "event", tickersHint: ["ACME"], observation: null }, { sources: [], callModel: never, now: day1, env: {} as NodeJS.ProcessEnv, fetchImpl: emptyRss, data: null } as never);
    expect(r.outcome).toBe("capped");
    expect(r.outcome !== "card" && r.reason).toMatch(/^waiting: daily LLM cap reached .*queued, researched after the midnight ET reset/);
    const waiting = await queueRows("pending");
    expect(waiting.map((w) => [w.kind, (w.payload as { term: string }).term])).toEqual([["research", "insider: ACME CEO buys"]]);
    // Asking again the same day does not queue it twice, and the cooldown does not treat it as done.
    await researchCandidate({ origin: "scout", term: "insider: ACME CEO buys", kindHint: "event", tickersHint: ["ACME"], observation: null }, { sources: [], callModel: never, now: day1, env: {} as NodeJS.ProcessEnv, fetchImpl: emptyRss, data: null } as never);
    expect(await queueRows("pending")).toHaveLength(1);
    expect([...(await store.recentTerms(30))]).not.toContain("insider: acme ceo buys");
  });

  it("after the reset the queue is worked through, oldest first; while still capped it waits", async () => {
    await pg.query(`DELETE FROM catchup_queue`);
    await enqueue("rumor_doc", "dump-1", { text: "Posters claim ACME will lose its biggest customer next week, according to a supplier thread.", source: "dump.zip" });
    let calls = 0;
    const model: CallModel = async ({ purpose }) => {
      calls++;
      if (purpose === "rumor_check") return { text: JSON.stringify({ results: [] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0 };
      return { text: JSON.stringify({ rumors: [{ claim: "Posters claim ACME will lose its biggest customer", tickers: ["ACME"], direction: "short", category: "corporate", specificity: 3, timeframe: "next week", confirm: "an 8-K", source: "", quote: "" }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01 };
    };
    const deps = { sources: [], callModel: model, env: {} as NodeJS.ProcessEnv, fetchImpl: emptyRss, data: null };
    // Still the capped day: nothing runs, nothing is lost.
    expect(await drainQueue({ ...deps, now: day1 } as never)).toMatch(/wait for the next budget reset/);
    expect(calls).toBe(0);
    // The next morning: it is read.
    const res = await drainQueue({ ...deps, now: day2 } as never);
    expect(res).toMatch(/^1 caught up/);
    expect(await queueRows("pending")).toHaveLength(0);
    expect((await queueRows("done"))[0].result).toBe("1 rumors");
  });
});
