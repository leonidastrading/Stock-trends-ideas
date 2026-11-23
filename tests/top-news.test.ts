import { describe, expect, it } from "vitest";
import type { FeedItem } from "@/lib/scout/newsfeed";
import { applyPicks, candidates, promptList, ruleTop, weight } from "@/lib/scout/top-news";

const now = new Date("2026-11-23T15:00:00Z");
const item = (id: string, hoursAgo: number, score: number, symbols: string[], headline = `Headline ${id}`, extra: Partial<FeedItem> = {}): FeedItem => ({
  id, at: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), headline, summary: "", source: "Benzinga", url: `https://x/${id}`, symbols,
  event: "merger", cardIds: [], buzz: 1, score: Math.round(score * Math.pow(0.5, hoursAgo / 6) * 100) / 100, kind: "news", ...extra,
});

describe("top news", () => {
  it("weighs stories by size, not freshness", () => {
    const big = item("big", 18, 4, ["NVDA"]), small = item("small", 0.5, 1.5, ["XYZ"]);
    expect(weight(big, now)).toBeCloseTo(4, 1);
    expect(candidates([small, big], now).map((c) => c.id)).toEqual(["big", "small"]);
  });

  it("leaves out old items, re-posts, routine pauses and repeated headlines", () => {
    const c = candidates([item("old", 30, 5, ["A"]), item("re", 1, 5, ["B"], "x", { repostedAt: "2026-11-23T14:00:00Z" }), item("p", 1, 5, ["C"], "y", { event: "paused" }), item("d1", 1, 3, ["D"], "Same story"), item("d2", 2, 3, ["D"], "Same story!")], now);
    expect(c.map((x) => x.id)).toEqual(["d2"]); // the earlier of the two
  });

  it("rules: one story per stock", () => {
    const r = ruleTop([item("a", 1, 4, ["AAPL"]), item("b", 2, 3.5, ["AAPL"]), item("c", 3, 3, ["MSFT"])], now);
    expect(r.map((p) => p.id)).toEqual(["a", "c"]);
    expect(r[0].why).toBe("merger");
  });

  it("maps the model's picks, dropping unknown and repeated ids", () => {
    const cands = [item("a", 1, 4, ["AAPL"]), item("b", 2, 3, ["MSFT"])];
    expect(applyPicks(cands, [{ id: "b", why: " Big deal " }, { id: "zz", why: "x" }, { id: "b", why: "again" }, { id: "a", why: "y" }]).map((p) => [p.id, p.why])).toEqual([["b", "Big deal"], ["a", "y"]]);
  });

  it("lists candidates for the model with id, ET time, source and tickers", () => {
    expect(promptList([item("a", 1, 4, ["AAPL"], "Apple buys X")])).toBe("[a] 2026-11-23 09:00 ET · Benzinga · AAPL\nApple buys X");
  });
});
