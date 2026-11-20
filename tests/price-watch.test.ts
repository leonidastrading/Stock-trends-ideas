import { describe, expect, it } from "vitest";
import { bigMoves, confirmed, earningsReason, likelyReason, moveItem, type BigMove } from "@/lib/scout/price-watch";
import { breakingNews, rankFeed } from "@/lib/scout/newsfeed";

const today = "2026-11-19";
const now = new Date("2026-11-19T16:01:00Z"); // 11:01 AM ET
const at = "2026-11-19T16:00:30Z";

const amd: BigMove = { symbol: "AMD", pct: -8.3, price: 486.29, prevClose: 530.14, date: today, level: 5, key: "move:AMD:2026-11-19:regular:5", firstSeen: "2026-11-19T15:34:00Z", phase: "regular", vs: "the last close" };

describe("price watch", () => {
  it("catches big companies past 5% and 10% in the regular session, biggest first, and ignores stale prices", () => {
    const moves = bigMoves({
      AMD: { price: 486.29, prevClose: 530.14, sessionDate: today, at, dailyClose: 486.29 },
      NVDA: { price: 180, prevClose: 178, sessionDate: today, at },
      HUM: { price: 340, prevClose: 385.78, sessionDate: today, at },
      OLD: { price: 50, prevClose: 100, sessionDate: "2026-11-18", at: "2026-11-18T20:00:00Z" },
      UP: { price: 112, prevClose: 100, sessionDate: today, at },
    }, today, [5, 10], now);
    expect(moves.map((m) => [m.symbol, m.pct, m.level, m.phase])).toEqual([["UP", 12, 10, "regular"], ["HUM", -11.9, 10, "regular"], ["AMD", -8.3, 5, "regular"]]);
    expect(moves[2].key).toBe("move:AMD:2026-11-19:regular:5");
  });

  it("after hours is measured from today's close (ROST, Nov 19 2026), not the day before's", () => {
    const post = new Date("2026-11-19T21:20:00Z"); // 4:20 PM ET
    const rost = { price: 199.85, prevClose: 227.61, sessionDate: today, at: "2026-11-19T21:15:00Z", dailyClose: 222.5 };
    const [m] = bigMoves({ ROST: rost }, today, [5, 10], post);
    expect(m).toMatchObject({ phase: "post", pct: -10.2, prevClose: 222.5, vs: "today's close", key: "move:ROST:2026-11-19:post:10" });
    expect(moveItem({ ...m, firstSeen: post.toISOString() }, null).headline).toBe("ROST down 10.2% after hours, no headline in the scout's feeds yet");
    // A 4% after-hours dip on top of a 2% fall in the day is not a 5% "move".
    expect(bigMoves({ ROST: { ...rost, price: 213.6 } }, today, [5, 10], post)).toEqual([]);
  });

  it("pre-market is measured from the last close, and one odd trade the quote does not back is ignored", () => {
    const pre = new Date("2026-11-19T12:30:00Z"); // 7:30 AM ET
    const [m] = bigMoves({ X: { price: 90, prevClose: 101, sessionDate: "2026-11-18", dailyClose: 100, at: "2026-11-19T12:29:00Z" } }, today, [5, 10], pre);
    expect(m).toMatchObject({ phase: "pre", pct: -10, prevClose: 100 });
    expect(bigMoves({ X: { price: 90, prevClose: 100, sessionDate: today, at, mid: 99.6 } }, today, [5, 10], now)).toEqual([]);
    expect(bigMoves({ X: { price: 90, prevClose: 100, sessionDate: today, at, mid: 90.2 } }, today, [5, 10], now)).toHaveLength(1);
  });

  it("stocks under $5 are not market news, and law-firm ads are not a reason (FMC, Nov 19 2026)", () => {
    expect(bigMoves({ FMC: { price: 4.29, prevClose: 4.67, sessionDate: today, at } }, today, [5, 10], now)).toEqual([]);
    const ad = [{ ts: "2026-11-19T15:50:00Z", headline: "Law Firms Initiate Securities Litigation Investigations and File Complaint Against FMC", symbols: ["FMC"], source: "fiscal.ai", url: "" }];
    expect(likelyReason("FMC", ad, now)).toBeNull();
    expect(likelyReason("FMC", [...ad, { ts: "2026-11-19T15:40:00Z", headline: "FMC cuts dividend", symbols: ["FMC"], source: "x", url: "" }], now)?.headline).toBe("FMC cuts dividend");
    const items = [
      { id: "p", at: "2026-11-19T15:55:00Z", headline: "FMC plunges on dividend cut", summary: "", source: "x", url: "", symbols: ["FMC"], kind: "news" as const },
      { id: "q", at: "2026-11-19T15:55:00Z", headline: "Visa plunges on dividend cut", summary: "", source: "x", url: "", symbols: ["V"], kind: "news" as const },
    ];
    const [a, b] = rankFeed(items, new Map(), now, new Set(["FMC"]));
    expect(a.score).toBeCloseTo(b.score * 0.2, 1);
  });

  it("a move must hold for two checks before it is pushed", () => {
    expect(confirmed({ ...amd, firstSeen: "2026-11-19T16:00:20Z" }, now)).toBe(false);
    expect(confirmed({ ...amd, firstSeen: "2026-11-19T15:59:00Z" }, now)).toBe(true);
  });

  it("finds the likely headline from the last 3 hours, then an earnings release, and says so when there is none", () => {
    const news = [
      { ts: "2026-11-19T15:35:00Z", headline: "AMD falls after Hunterbrook flags China export-control risks", symbols: ["AMD"], source: "fiscal.ai", url: "https://x/amd" },
      { ts: "2026-11-19T10:00:00Z", headline: "AMD old story", symbols: ["AMD"], source: "x", url: "" },
    ];
    expect(likelyReason("AMD", news, now)?.headline).toMatch(/Hunterbrook/);
    expect(likelyReason("AMD", news.slice(1), now)).toBeNull();
    expect(moveItem(amd, null).headline).toBe("AMD down 8.3% today, no headline in the scout's feeds yet");
    expect(moveItem(amd, likelyReason("AMD", news, now)).headline).toBe("AMD down 8.3% today: AMD falls after Hunterbrook flags China export-control risks");
    const cal = [{ symbol: "ROST", date: today, time: "time-after-hours" }, { symbol: "WMT", date: "2026-11-18", time: "time-after-hours" }];
    expect(earningsReason("ROST", cal, today, "post")?.headline).toBe("ROST reported earnings today after the close");
    expect(earningsReason("WMT", cal, today, "pre")?.headline).toBe("WMT reported earnings yesterday after the close");
    expect(earningsReason("WMT", cal, today, "regular")).toBeNull();
  });

  it("a big move tops News and makes the breaking strip", () => {
    const mv = moveItem(amd, null);
    const items = [
      { id: "m", at: mv.ts, headline: mv.headline, summary: mv.summary, source: mv.source, url: mv.url, symbols: mv.symbols, kind: "news" as const },
      { id: "a", at: "2026-11-19T15:50:00Z", headline: "Company beats estimates", summary: "", source: "fiscal.ai", url: "", symbols: ["XYZ"], kind: "news" as const },
    ];
    const ranked = rankFeed(items, new Map(), now).sort((a, b) => b.score - a.score);
    expect(ranked[0]).toMatchObject({ id: "m", event: "big move" });
    expect(breakingNews(ranked, now, 30, 1).map((b) => [b.id, b.why])).toContainEqual(["m", "big move"]);
  });
});

describe("the News badge counts top stories only", () => {
  it("a big move or an event counts; a plain headline, a pause or a stock under $5 does not", async () => {
    const { isTopStory } = await import("@/lib/scout/newsfeed");
    const now = new Date("2026-11-19T16:01:00Z");
    const at = "2026-11-19T16:00:00Z";
    const items = [
      { id: "a", at, headline: "AMD down 8.3% today", summary: "", source: "Scout price watch", url: "", symbols: ["AMD"], kind: "news" as const },
      { id: "b", at, headline: "Company announces new office in Denver", summary: "", source: "x", url: "", symbols: ["XYZ"], kind: "news" as const },
      { id: "c", at, headline: "FMC halted, then guidance cut", summary: "", source: "x", url: "", symbols: ["FMC"], kind: "news" as const },
      { id: "d", at, headline: "Acme cuts guidance", summary: "", source: "x", url: "", symbols: ["ACME"], kind: "news" as const },
    ];
    const ranked = rankFeed(items, new Map(), now, new Set(["FMC"]));
    expect(ranked.filter(isTopStory).map((i) => i.id)).toEqual(["a", "d"]);
  });
});
