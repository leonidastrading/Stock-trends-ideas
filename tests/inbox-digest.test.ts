import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { parseDigest, rank, refreshInboxDigest } from "@/lib/scout/inbox-digest";
import type { CallModel } from "@/lib/scout/llm";
import * as store from "@/lib/scout/store";

describe("inbox summary ranking", () => {
  it("breaking and important first, then recent; stale 'breaking' does not jump the queue", () => {
    const x = (id: string, importance: number, breaking: boolean, date: string) => ({ id, importance, breaking, date });
    const r = rank([x("old-big", 5, false, "2026-11-05"), x("fresh-mid", 3, false, "2026-11-15"), x("breaking", 4, true, "2026-11-15"), x("stale-breaking", 4, true, "2026-11-09"), x("fresh-big", 5, false, "2026-11-14")], "2026-11-15");
    expect(r.map((i) => i.id)).toEqual(["breaking", "fresh-big", "fresh-mid", "stale-breaking", "old-big"]);
  });

  it("parses the reply and drops malformed items", () => {
    const d = parseDigest(JSON.stringify({ ideas: [{ title: "A", importance: 4, date: "2026-11-14" }, { title: "bad" }], news: [] }));
    expect(d.ideas.map((i) => i.title)).toEqual(["A"]);
    expect(d.news).toEqual([]);
  });
});

describe("refresh (PGlite, stored document text, fake model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("summarises the last few days' documents with the scout's outcomes, logs the cost, keeps the summary", async () => {
    await store.markInbox("inbox/2026-11-14-youtube.json", "a1", { via: "block", ideas: 2 }, "Prenetics IM8 subscriptions at 140K; Q3 on Nov 20. Fed minutes Wednesday.");
    await store.markInbox("inbox/2026-11-14-broken.pdf", "b2", { error: "unreadable" }, null);
    let prompt = "";
    const callModel: CallModel = async ({ user, purpose }) => {
      prompt = `${purpose}: ${user}`;
      return { text: JSON.stringify({ ideas: [{ title: "Prenetics IM8 beat", tickers: ["PRE"], direction: "long", summary: "140K subs", source: "2026-11-14-youtube", date: "2026-11-14", importance: 4, breaking: false, card_id: 0 }], news: [{ headline: "Fed minutes Wednesday", tickers: [], summary: "minutes", source: "2026-11-14-youtube", date: "2026-11-14", importance: 3, breaking: false }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.02 };
    };
    const deps = { data: null, sources: [], callModel, now: new Date("2026-11-15T17:00:00Z"), env: {} as NodeJS.ProcessEnv };
    expect(await refreshInboxDigest(deps)).toBe("1 ideas, 1 news from 1 document(s)");
    expect(prompt).toMatch(/^inbox_digest: Today is 2026-11-15/);
    expect(prompt).toMatch(/=== Document "2026-11-14-youtube" \(received .*\) ===\nPrenetics IM8 subscriptions/);
    expect(prompt).not.toMatch(/broken/);
    const latest = await store.latestInboxDigest<{ ideas: unknown[]; news: unknown[] }>();
    expect(latest).toMatchObject({ docs: ["2026-11-14-youtube"] });
    expect(latest!.digest.ideas).toHaveLength(1);
    expect((await store.spendOn("2026-11-15")).cost).toBeCloseTo(0.02);
  });
});
