import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { buildBriefing, CHAT_SYSTEM, historyFor } from "@/lib/scout/chat";
import * as store from "@/lib/scout/store";

describe("chat history", () => {
  it("keeps the last turns and always starts with a user message", () => {
    const m = (role: "user" | "assistant", content: string) => ({ role, content, at: "2026-11-15T12:00:00Z" });
    expect(historyFor([m("assistant", "stray"), m("user", "a"), m("assistant", "b")])).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
    const long = Array.from({ length: 40 }, (_, i) => m(i % 2 ? "assistant" : "user", String(i)));
    const h = historyFor(long, 5);
    expect(h[0]).toEqual({ role: "user", content: "36" });
    expect(h).toHaveLength(4);
  });

  it("a long paste goes in whole while it is recent, then shortened on later turns", () => {
    const m = (role: "user" | "assistant", content: string) => ({ role, content, at: "2026-11-15T12:00:00Z" });
    const paste = "x".repeat(50_000);
    expect(historyFor([m("user", paste)])[0].content).toHaveLength(50_000);
    const later = historyFor([m("user", paste), m("assistant", "read it"), m("user", "q1"), m("assistant", "a1"), m("user", "q2"), m("assistant", "a2")]);
    expect(later[0].content.length).toBeLessThan(8_200);
    expect(later[0].content).toContain("42,000 more characters were in this earlier message");
    expect(later.slice(2).map((x) => x.content)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("the system prompt keeps the scout paper-only and the keys private", () => {
    expect(CHAT_SYSTEM).toMatch(/never places, changes or cancels orders/);
    expect(CHAT_SYSTEM).toMatch(/Do not reveal API keys/);
  });
});

describe("briefing and threads (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("builds the briefing from what the scout has stored; a broken section does not break the rest", async () => {
    await store.cachePut("market", [{ label: "S&P 500 (SPY)", value: "$600.00", changePct: -0.42 }, { label: "10-year Treasury", value: "5.15%", changePct: 0.05 }]);
    await store.cachePut("earnings", { total: 293, rows: [{ date: "2026-11-17", symbol: "NVDA", name: "NVIDIA Corporation", eps: "$2.47", time: "after close" }] });
    await store.cachePut("buzz", "not an array"); // a corrupted cache entry
    await store.addCongressFiling({ docId: "1", chamber: "House", member: "Julie Johnson", stateDst: "TX32", filed: "2026-11-10", year: 2026, status: "read" },
      [{ docId: "1", ord: 0, chamber: "House", member: "Julie Johnson", stateDst: "TX32", filed: "2026-11-10", owner: "joint", symbol: "WBD", assetType: "stock", tx: "sell", txDate: "2026-10-07", notified: "2026-11-09", amountLow: 1001, amountHigh: 15000, amount: "$1,001 - $15,000" }]);
    const b = await buildBriefing(new Date("2026-11-15T17:00:00Z"));
    expect(b).toMatch(/^BRIEFING as of .* \(today is 2026-11-15, US Eastern\)/);
    expect(b).toMatch(/S&P 500 \(SPY\): \$600\.00 \(-0\.4%\)/);
    expect(b).toMatch(/10-year Treasury: 5\.15% \(\+0\.05 pts\)/);
    expect(b).toMatch(/293 companies report[\s\S]*NVDA \(NVIDIA Corporation\) 2026-11-17 after close, EPS est\. \$2\.47/);
    expect(b).toMatch(/Julie Johnson: sell WBD \$1,001 - \$15,000 \(traded 2026-10-07, 34d late\)/);
    expect(b).toMatch(/## Buzz[^\n]*\n\(unavailable/);
    expect(b).toMatch(/## Thesis cards[^\n]*\nNone yet\./);
  });

  it("stores a thread with its fixed briefing and appends turns", async () => {
    const id = await store.createChatThread("BRIEFING test");
    await store.appendChat(id, [{ role: "user", content: "hi", at: "2026-11-15T17:00:00Z" }, { role: "assistant", content: "hello", at: "2026-11-15T17:00:05Z" }]);
    await store.appendChat(id, [{ role: "user", content: "and?", at: "2026-11-15T17:01:00Z" }, { role: "assistant", content: "more", at: "2026-11-15T17:01:05Z" }]);
    const t = (await store.getChatThread(id))!;
    expect(t.briefing).toBe("BRIEFING test");
    expect(t.messages.map((m) => m.content)).toEqual(["hi", "hello", "and?", "more"]);
    expect((await store.recentChatThreads())[0]).toMatchObject({ id, first: "hi", turns: 2 });
  });
});

describe("asking from a card", () => {
  it("sends the question with the whole card, and the chat shows only the question", async () => {
    const { cardQuestion } = await import("@/lib/scout/chat");
    const { shownUserText } = await import("@/lib/scout/chat-text");
    const c = { id: 152, createdAt: "2026-11-14T19:52:00Z", status: "late", gateNotes: ["stock up 31% in 30 days"], direction: "long", primaryTicker: "LMT", title: "Trump urges lame-duck Senate to pass $350B defense bill", card: { title: "Trump urges…", confidence: 46, invalidation: "Bill dies in the Senate" } } as unknown as store.StoredCard;
    const msg = cardQuestion(c, null, "  Is it too late?  ");
    expect(msg.startsWith("About card #152 (long LMT: Trump urges lame-duck Senate to pass $350B defense bill): Is it too late?")).toBe(true);
    expect(msg).toContain('"invalidation": "Bill dies in the Senate"');
    expect(msg).toContain('"paperTrack": null');
    expect(shownUserText(msg)).toBe("About card #152 (long LMT: Trump urges lame-duck Senate to pass $350B defense bill): Is it too late?");
    expect(shownUserText("plain question")).toBe("plain question");
  });
});
