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
