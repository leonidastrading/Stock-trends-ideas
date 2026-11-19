import { describe, expect, it } from "vitest";
import { findExit, groupBars, maxDrawdownPct, symbolsNeeded } from "@/lib/scout/tracking";
import type { DailyBarRow, Track } from "@/lib/scout/store";

const bar = (symbol: string, date: string, o: number, c = o, l = Math.min(o, c) - 1, h = Math.max(o, c) + 1): DailyBarRow => ({ symbol, date, o, h, l, c, v: 1000 });
const track = (p: Partial<Track> = {}): Track => ({
  cardId: 1, symbol: "HUBB", sectorEtf: "XLI", direction: "long", cardDate: "2026-11-10", entryDate: "2026-11-11", entryPrice: 100, spyEntry: 600, sectorEntry: 140,
  deadlineDate: "2026-11-20", exitDate: null, exitPrice: null, spyExit: null, sectorExit: null, exitReason: null, maxDrawdownPct: null, tappedAt: null, swingResponse: null, ...p,
});
const bars = groupBars([bar("HUBB", "2026-11-11", 100, 102), bar("HUBB", "2026-11-12", 103, 98, 95), bar("HUBB", "2026-11-13", 99, 104), bar("HUBB", "2026-11-20", 110, 111), bar("HUBB", "2026-11-23", 112, 113)]);

describe("paper tracking", () => {
  it("exits at the open of the first session at or after the deadline", () => {
    expect(findExit(track(), bars.get("HUBB"), null, null)).toEqual({ date: "2026-11-20", price: 110, reason: "time_limit" });
    expect(findExit(track({ deadlineDate: "2026-11-21" }), bars.get("HUBB"), null, null)).toEqual({ date: "2026-11-23", price: 112, reason: "time_limit" });
    expect(findExit(track({ deadlineDate: "2026-12-01" }), bars.get("HUBB"), null, null)).toBeNull();
  });
  it("names the catalyst when the deadline is the day after it, and an invalidation exits the next open", () => {
    expect(findExit(track(), bars.get("HUBB"), null, "2026-11-19")!.reason).toBe("catalyst");
    expect(findExit(track(), bars.get("HUBB"), "2026-11-12", null)).toEqual({ date: "2026-11-13", price: 99, reason: "invalidated" });
    expect(findExit(track({ entryDate: null }), bars.get("HUBB"), null, null)).toBeNull();
  });
  it("drawdown is the worst intraday move against the position while held", () => {
    expect(maxDrawdownPct("long", 100, bars.get("HUBB")!, "2026-11-11", "2026-11-20")).toBe(-5);
    expect(maxDrawdownPct("short", 100, bars.get("HUBB")!, "2026-11-11", "2026-11-13")).toBeCloseTo(-5);
    expect(maxDrawdownPct("long", 90, bars.get("HUBB")!, "2026-11-11", null)).toBe(0);
  });
  it("needs bars for the stock, SPY, every sector fund and the sector's universe", () => {
    const s = symbolsNeeded([track()], ["industrials"]);
    expect(s).toContain("HUBB");
    expect(s).toContain("SPY");
    expect(s).toContain("XLI");
    expect(s).toContain("CAT");
    expect(s).not.toContain("AAPL");
  });
});

describe("entry at the next open after the card", () => {
  it("a card written before 9:30 AM ET enters that day's open; later, or on a weekend, the next session's", async () => {
    const { beforeOpen, entryBar } = await import("@/lib/scout/tracking");
    const bars = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23"].map((date, i) => ({ symbol: "HUM", date, o: 441.44 - i, h: 0, l: 0, c: 0, v: 0 }));
    expect(beforeOpen("2026-11-18", "2026-11-18T11:00:00Z")).toBe(true);  // 6:00 AM ET
    expect(entryBar(bars, "2026-11-18", "2026-11-18T11:00:00Z")?.date).toBe("2026-11-18");
    expect(entryBar(bars, "2026-11-18", "2026-11-18T14:31:00Z")?.date).toBe("2026-11-19"); // 9:31 AM ET: next session
    expect(entryBar(bars, "2026-11-21", "2026-11-21T13:00:00Z")?.date).toBe("2026-11-23"); // Saturday
    expect(entryBar(bars, "2026-11-18", null)?.date).toBe("2026-11-19");
  });
});
