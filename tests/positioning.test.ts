import { describe, expect, it } from "vitest";
import { crowdBand, gammaBand, type CardProfile } from "@/lib/scout/card-profiles";
import { bsGamma, cotMarketFor, cotReading, cotText, gammaProfile, gammaText, type GammaContract } from "@/lib/market/positioning";

const week = (i: number) => new Date(Date.UTC(2023, 10, 7) + i * 7 * 86400_000).toISOString().slice(0, 10) + "T00:00:00.000";

describe("CFTC Commitments of Traders", () => {
  it("reads leveraged funds' net position, its 3-year percentile and flags crowding", () => {
    // 156 weeks of net positions from -100k to +55k, then this week at a record +80k.
    const rows = Array.from({ length: 157 }, (_, i) => ({
      report_date_as_yyyy_mm_dd: week(i), cftc_contract_market_code: "13874A", open_interest_all: "2000000",
      lev_money_positions_long: String(300000 + (i === 156 ? 80000 : -100000 + i * 1000)), lev_money_positions_short: "300000",
    }));
    const r = cotReading({ key: "es", name: "S&P 500 (e-mini)", ds: "tff" }, rows)!;
    expect(r).toMatchObject({ net: 80000, netPctOi: 4, crowd: "crowded long", who: "leveraged funds", weeks: 156 });
    expect(r.index3y).toBeGreaterThanOrEqual(99);
    expect(r.change1w).toBe(80000 - (-100000 + 155 * 1000));
    expect(cotText(r)).toMatch(/S&P 500 \(e-mini\): leveraged funds net long 80,000 contracts \(4% of open interest\), 100th percentile of 3 years.*CROWDED LONG/);
  });

  it("reads managed money for commodities, and a mid-range position is not crowded", () => {
    const rows = Array.from({ length: 65 }, (_, i) => ({ report_date_as_yyyy_mm_dd: week(i), m_money_positions_long_all: String(200000 + (i % 10) * 1000), m_money_positions_short_all: "195000", open_interest_all: "1500000" }));
    const r = cotReading({ key: "cl", name: "Crude oil (WTI)", ds: "dis" }, rows)!;
    expect(r.who).toBe("managed money");
    expect(r.crowd).toBeNull();
  });

  it("maps stocks and ETFs to their futures market", () => {
    expect(cotMarketFor("USO")?.key).toBe("cl");
    expect(cotMarketFor("spy")?.key).toBe("es");
    expect(cotMarketFor("AAPL")).toBeUndefined();
  });
});

describe("dealer gamma", () => {
  it("Black-Scholes gamma matches a known value", () => {
    // S = K = 100, 1 year, 20% vol, r = 4%: d1 = 0.3, gamma = φ(0.3)/(100·0.2) ≈ 0.019069.
    expect(bsGamma(100, 100, 1, 0.2, 0.04)).toBeCloseTo(0.019069, 5);
    expect(bsGamma(100, 100, 0, 0.2)).toBe(0);
  });

  it("finds the flip between heavy put gamma below and call gamma above, and the walls", () => {
    const today = new Date("2026-11-17T15:00:00Z");
    const c = (type: "call" | "put", strike: number, oi: number): GammaContract => ({ type, strike, expiry: "2026-12-18", oi, iv: 0.2, gamma: null });
    const chain: GammaContract[] = [];
    for (let k = 80; k <= 120; k += 1) {
      chain.push(c("put", k, k <= 98 ? 20000 : 1000));
      chain.push(c("call", k, k >= 102 ? 20000 : 1000));
    }
    const above = gammaProfile("XYZ", 106, "2026-11-17", chain, today)!;
    expect(above.regime).toBe("damping");
    expect(above.flip).toBeGreaterThan(98);
    expect(above.flip).toBeLessThan(106);
    expect(above.callWall).toBeGreaterThanOrEqual(102);
    expect(above.putWall).toBeLessThanOrEqual(98);
    const below = gammaProfile("XYZ", 94, "2026-11-17", chain, today)!;
    expect(below.regime).toBe("amplifying");
    expect(gammaText(below)).toMatch(/negative: dealers amplify moves; gamma flip \$\d/);
    expect(gammaProfile("XYZ", 100, "2026-11-17", chain.slice(0, 5), today)).toBeNull();
  });
});

describe("scoring groups", () => {
  const p = (positioning: CardProfile["positioning"]): CardProfile => ({ cardId: 1, symbol: "USO", capturedAt: "", marketCap: null, capBucket: null, shortPctFloat: null, shortPctOut: null, daysToCover: null, squeeze: null, shortAsOf: null, late: false, positioning });
  it("puts a card with or against a crowded side, and by gamma regime", () => {
    const crowdedLong = p({ cot: { market: "Crude oil (WTI)", index3y: 95, crowd: "crowded long", net: 300000 }, gamma: { regime: "amplifying", flip: 80, callWall: 85, putWall: 70, spot: 75 } });
    expect(crowdBand(crowdedLong, "long")).toBe("with a crowded side");
    expect(crowdBand(crowdedLong, "short")).toBe("against a crowded side");
    expect(crowdBand(p({ cot: { market: "x", index3y: 50, crowd: null, net: 0 }, gamma: null }), "long")).toBe("positioning not crowded");
    expect(crowdBand(undefined, "long")).toBe("no futures market");
    expect(gammaBand(crowdedLong)).toBe("dealers amplifying (negative gamma)");
    expect(gammaBand(undefined)).toBe("no gamma estimate");
  });
});
