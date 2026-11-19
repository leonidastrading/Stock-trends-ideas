import { describe, expect, it } from "vitest";
import { breakingNews, type FeedItem } from "@/lib/scout/newsfeed";

const now = new Date("2026-11-16T15:00:00Z");
const item = (id: string, minsAgo: number, extra: Partial<FeedItem> = {}): FeedItem => ({ id, at: new Date(now.getTime() - minsAgo * 60_000).toISOString(), headline: `headline ${id}`, summary: "", source: "benzinga", url: `https://x/${id}`, symbols: ["ABC"], event: null, cardIds: [], buzz: 1, score: 1, kind: "news", ...extra });

describe("breaking-news ticker", () => {
  it("keeps the last 3 hours' breaking stories, newest first, never re-posts", () => {
    const items = [
      item("halt", 10, { event: "halt" }), item("card", 30, { cardIds: [7] }), item("trump", 5, { kind: "trump" }), item("pile", 50, { buzz: 4 }),
      item("old", 200, { event: "fda" }), item("repost", 20, { event: "fda", repostedAt: now.toISOString() }), item("plain", 15),
    ];
    const b = breakingNews(items, now, 30, 4);
    expect(b.map((x) => x.id)).toEqual(["trump", "halt", "card", "pile"]);
    expect(b.map((x) => x.why)).toEqual(["Trump", "halt", "on your cards", "4 stories"]);
  });

  it("tops up with the latest headlines when the hour is quiet", () => {
    const b = breakingNews([item("a", 5), item("b", 50), item("c", 20, { event: "downgrade" })], now, 30, 3);
    expect(b.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("leaves routine volatility pauses out, even as filler", () => {
    const b = breakingNews([item("pause", 5, { event: "paused", source: "Nasdaq halts" }), item("plain", 15)], now, 30, 4);
    expect(b.map((x) => x.id)).toEqual(["plain"]);
  });
});
