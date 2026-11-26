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

describe("the line under each summary item", () => {
  it("says importance in words, when the document arrived (ET), and where it came from", async () => {
    const { itemMeta, shortSource } = await import("@/lib/scout/inbox-digest");
    const received = new Map([["2026-11-15-discord-2", "2026-11-15T12:42:00Z"], ["2026-11-14-discord", "2026-11-15T01:05:00Z"]]);
    expect(itemMeta({ source: "2026-11-15-discord-2", date: "2026-11-15", importance: 4 }, received)).toBe("high importance · received Nov 15, 7:42 AM ET · from discord-2");
    // Arrived late on the 14th New York time (after 8 PM ET is the 15th in UTC): no extra "about" date.
    expect(itemMeta({ source: "2026-11-14-discord", date: "2026-11-14", importance: 3 }, received)).toBe("medium importance · received Nov 14, 8:05 PM ET · from discord");
    expect(itemMeta({ source: "2026-11-15-discord-2, 2026-11-14-discord", date: "2026-11-10", importance: 5 }, received)).toBe("major importance · received Nov 15, 7:42 AM ET · about Nov 10 · from discord-2, discord");
    expect(itemMeta({ source: "unknown-doc", date: "2026-11-12", importance: 1 }, received)).toBe("minor importance · Nov 12 · from unknown-doc");
    expect(shortSource("2026-11-14-discord-meetkevin-alpha-report-2026-11-10")).toBe("discord-meetkevin-alpha-report-2026-11-10");
  });
});

import { digestDue } from "@/lib/scout/inbox-digest";

describe("the summary is rewritten twice a day", () => {
  const at = (et: string) => new Date(`2026-11-27T${et}:00-05:00`);
  it("waits for the morning or afternoon time, and for a document newer than the last summary", () => {
    const yesterdayEvening = "2026-11-26T22:00:00.000Z", doc = at("08:10").toISOString();
    expect(digestDue(at("08:30"), yesterdayEvening, doc)).toBe(false); // before 9:00
    expect(digestDue(at("09:05"), yesterdayEvening, doc)).toBe(true); // the morning rewrite
    expect(digestDue(at("11:00"), at("09:05").toISOString(), at("10:30").toISOString())).toBe(false); // already rewritten this morning
    expect(digestDue(at("16:20"), at("09:05").toISOString(), at("10:30").toISOString())).toBe(true); // the afternoon rewrite
    expect(digestDue(at("16:20"), at("09:05").toISOString(), at("08:10").toISOString())).toBe(false); // nothing new since
    expect(digestDue(at("03:00"), null, doc)).toBe(true); // no summary yet
    expect(digestDue(at("12:00"), null, null)).toBe(false);
  });
});
