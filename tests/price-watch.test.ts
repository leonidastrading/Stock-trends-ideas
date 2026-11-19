import { describe, expect, it } from "vitest";
import { bigMoves, likelyReason, moveItem } from "@/lib/scout/price-watch";
import { breakingNews, rankFeed } from "@/lib/scout/newsfeed";

const today = "2026-11-19";
const now = new Date("2026-11-19T16:01:00Z"); // 11:01 AM ET

describe("price watch", () => {
  it("catches big companies past 5% and 10% today, biggest first, and ignores stale sessions", () => {
    const moves = bigMoves({
      AMD: { price: 486.29, prevClose: 530.14, sessionDate: today },
      NVDA: { price: 180, prevClose: 178, sessionDate: today },
      HUM: { price: 340, prevClose: 385.78, sessionDate: today },
      OLD: { price: 50, prevClose: 100, sessionDate: "2026-11-18" },
      UP: { price: 112, prevClose: 100, sessionDate: today },
    }, today);
    expect(moves.map((m) => [m.symbol, m.pct, m.level])).toEqual([["UP", 12, 10], ["HUM", -11.9, 10], ["AMD", -8.3, 5]]);
    expect(moves[2].key).toBe("move:AMD:2026-11-19:5");
  });

  it("finds the likely headline from the last 3 hours, and says so when there is none", () => {
    const news = [
      { ts: "2026-11-19T15:35:00Z", headline: "AMD falls after Hunterbrook flags China export-control risks", symbols: ["AMD"], source: "fiscal.ai", url: "https://x/amd" },
      { ts: "2026-11-19T10:00:00Z", headline: "AMD old story", symbols: ["AMD"], source: "x", url: "" },
    ];
    expect(likelyReason("AMD", news, now)?.headline).toMatch(/Hunterbrook/);
    expect(likelyReason("AMD", news.slice(1), now)).toBeNull();
    const m = { symbol: "AMD", pct: -8.3, price: 486.29, prevClose: 530.14, date: today, level: 5, key: "move:AMD:2026-11-19:5", firstSeen: "2026-11-19T15:34:00Z" };
    expect(moveItem(m, null).headline).toBe("AMD down 8.3% today, no headline in the scout's feeds yet");
    expect(moveItem(m, likelyReason("AMD", news, now)).headline).toBe("AMD down 8.3% today: AMD falls after Hunterbrook flags China export-control risks");
  });

  it("a big move tops News and makes the breaking strip", () => {
    const m = { symbol: "AMD", pct: -8.3, price: 486.29, prevClose: 530.14, date: today, level: 5, key: "move:AMD:2026-11-19:5", firstSeen: "2026-11-19T15:34:00Z" };
    const mv = moveItem(m, null);
    const items = [
      { id: "m", at: mv.ts, headline: mv.headline, summary: mv.summary, source: mv.source, url: mv.url, symbols: mv.symbols, kind: "news" as const },
      { id: "a", at: "2026-11-19T15:50:00Z", headline: "Company beats estimates", summary: "", source: "fiscal.ai", url: "", symbols: ["XYZ"], kind: "news" as const },
    ];
    const ranked = rankFeed(items, new Map(), now).sort((a, b) => b.score - a.score);
    expect(ranked[0]).toMatchObject({ id: "m", event: "big move" });
    expect(breakingNews(ranked, now, 30, 1).map((b) => [b.id, b.why])).toContainEqual(["m", "big move"]);
  });
});
