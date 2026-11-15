import { describe, expect, it } from "vitest";
import { parseNasdaqShort, shortText, squeezeFrom } from "@/lib/market/short";
import { readFundamentals, readShortInterest } from "@/lib/sources/schwab";

const nasdaq = {
  data: {
    symbol: "GME",
    shortInterestTable: {
      headers: { settlementDate: "Settlement Date", interest: "Short Interest", avgDailyShareVolume: "Avg. Daily Share Volume", daysToCover: "Days to Cover" },
      rows: [
        { settlementDate: "10/31/2026", interest: "61,234,567", avgDailyShareVolume: "5,123,456", daysToCover: "11.95" },
        { settlementDate: "10/15/2026", interest: "55,000,000", avgDailyShareVolume: "4,900,000", daysToCover: "11.22" },
      ],
    },
  },
  message: null,
  status: { rCode: 200 },
};

describe("short interest", () => {
  it("reads FINRA's consolidated short interest (newest first, previous report for the change)", async () => {
    const { parseFinraShort } = await import("@/lib/market/short");
    const rows = [
      { symbolCode: "GME", issueName: "GameStop Corp", settlementDate: "2026-10-31", currentShortPositionQuantity: 61234567, previousShortPositionQuantity: 55000000, daysToCoverQuantity: 11.95, averageDailyVolumeQuantity: 5123456 },
      { symbolCode: "GME", settlementDate: "2026-10-15", currentShortPositionQuantity: 55000000, previousShortPositionQuantity: 50000000, daysToCoverQuantity: 11.2 },
    ];
    expect(parseFinraShort("GME", rows)).toEqual({ symbol: "GME", interest: 61234567, asOf: "2026-10-31", daysToCover: 11.95, changePct: 11.3, source: "FINRA" });
    expect(parseFinraShort("GME", [])).toBeNull();
  });

  it("reads Nasdaq's latest report and the change since the one before", () => {
    expect(parseNasdaqShort("GME", nasdaq)).toEqual({ symbol: "GME", interest: 61234567, asOf: "2026-10-31", daysToCover: 11.95, changePct: 11.3, source: "Nasdaq" });
    expect(parseNasdaqShort("XYZ", { data: null, status: { rCode: 400 } })).toBeNull();
  });

  it("Schwab's zeros count as no data; shares outstanding is kept for % of shares short", () => {
    const f = readFundamentals("GME", { shortIntToFloat: 0, shortIntDayToCover: 0, sharesOutstanding: 447_000_000, marketCapFloat: 0, peRatio: 40 });
    expect(f.short).toMatchObject({ pctFloat: null, daysToCover: null });
    expect(f.sharesOutstanding).toBe(447_000_000);
    expect(f.floatShares).toBeNull(); // marketCapFloat 0 = no data
    expect(readFundamentals("GME", { sharesOutstanding: 504_500_990, marketCapFloat: 460_411_538.582 }).floatShares).toBeCloseTo(460_411_538.582);
    expect(readShortInterest("X", { shortIntToFloat: 21.4 }).pctFloat).toBe(21.4);
  });

  it("says it in one line, with squeeze risk", () => {
    expect(squeezeFrom(13.7, 11.95)).toBe("high");
    expect(squeezeFrom(12, 2)).toBe("elevated");
    expect(squeezeFrom(null, null)).toBeNull();
    expect(shortText({ interest: 61234567, asOf: "2026-10-31", changePct: 11.3, daysToCover: 11.95, pctOutstanding: 13.7, squeeze: "high" })).toBe("13.7% of shares short (61.2M), 11.95 days to cover, +11.3% vs the prior report (settled 2026-10-31); squeeze risk high");
    expect(shortText({ interest: 61234567, asOf: "2026-10-31", changePct: null, daysToCover: 11.95, pctFloat: 13.3, pctOutstanding: 12.1, squeeze: "high" })).toBe("13.3% of float short (61.2M shares), 11.95 days to cover (settled 2026-10-31); squeeze risk high");
    expect(shortText({ interest: 850000, asOf: "2026-10-31", changePct: null, daysToCover: null, pctOutstanding: null, squeeze: null })).toBe("850k shares short (settled 2026-10-31)");
    expect(shortText(null)).toBeNull();
  });
});
