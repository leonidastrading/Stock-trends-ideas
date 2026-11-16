import { describe, expect, it } from "vitest";
import { buildProfile, capBucket, fmtCap, parseNasdaqCap } from "@/lib/market/profile";
import type { ShortData } from "@/lib/market/short";

describe("stock profile: market cap and short interest", () => {
  it("reads the market cap from Nasdaq's summary", () => {
    expect(parseNasdaqCap({ data: { summaryData: { MarketCap: { label: "Market Cap", value: "1,169,862,840" } } } })).toBe(1169862840);
    expect(parseNasdaqCap({ data: { summaryData: { MarketCap: { label: "Market Cap", value: "N/A" } } } })).toBeNull();
    expect(parseNasdaqCap({ data: null })).toBeNull();
  });

  it("formats the cap and names its size group", () => {
    expect(fmtCap(1169862840)).toBe("$1.2B");
    expect(fmtCap(850e6)).toBe("$850M");
    expect(fmtCap(4.3e12)).toBe("$4.3T");
    expect(fmtCap(null)).toBeNull();
    expect([capBucket(1.2e9), capBucket(15e9), capBucket(400e9), capBucket(40e6)]).toEqual(["small cap", "large cap", "mega cap", "nano cap"]);
  });

  it("falls back to Schwab's shares × price when Nasdaq has no cap", () => {
    const short: ShortData = { symbol: "FUN", interest: 9e6, asOf: "2026-10-31", changePct: 4, daysToCover: 3.1, pctFloat: 9.4, pctOutstanding: 8.9, sharesOutstanding: 101e6, squeeze: "elevated", source: "FINRA; float from Schwab" };
    expect(buildProfile(null, short, null, 11.55)).toMatchObject({ marketCap: 101e6 * 11.55, capSource: "Schwab shares × price" });
    expect(buildProfile(1.17e9, short, null, 11.55)).toMatchObject({ marketCap: 1.17e9, capSource: "Nasdaq" });
    expect(buildProfile(null, null, "FINRA: no report", 11.55)).toMatchObject({ marketCap: null, capSource: null, shortError: "FINRA: no report" });
  });
});

describe("card profiles: bands for scoring", async () => {
  const { sizeBand, shortBand } = await import("@/lib/scout/card-profiles");
  const p = (marketCap: number | null, shortPctFloat: number | null, shortPctOut: number | null = null) => ({ cardId: 1, symbol: "X", capturedAt: "", marketCap, capBucket: null, shortPctFloat, shortPctOut, daysToCover: null, squeeze: null, shortAsOf: null, late: false });
  it("puts each card in a size band and a short-interest band", () => {
    expect([sizeBand(p(6.6e9, null)), sizeBand(p(1.2e9, null)), sizeBand(p(40e6, null)), sizeBand(p(4e12, null)), sizeBand(undefined)]).toEqual(["mid cap ($2–10B)", "small cap ($300M–2B)", "nano or micro cap (under $300M)", "mega cap ($200B+)", "size unknown"]);
    expect([shortBand(p(null, 9.2)), shortBand(p(null, null, 25)), shortBand(p(null, 3)), shortBand(p(null, null))]).toEqual(["5–10% short", "20%+ short", "under 5% short", "short interest unknown"]);
  });
});

describe("Ideas filters: size and short interest", async () => {
  const { sizeKey, shortPct } = await import("@/lib/scout/card-profiles");
  it("maps a market cap to its size filter and reads % of float short", () => {
    expect([sizeKey(6.6e9), sizeKey(250e6), sizeKey(1.2e9), sizeKey(50e9), sizeKey(3e12), sizeKey(null)]).toEqual(["mid", "micro", "small", "large", "mega", null]);
    expect([shortPct({ shortPctFloat: 9.2, shortPctOut: 8 }), shortPct({ shortPctFloat: null, shortPctOut: 8 }), shortPct(undefined)]).toEqual([9.2, 8, null]);
  });
});
