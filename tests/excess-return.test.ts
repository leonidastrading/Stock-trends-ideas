import { describe, expect, it } from "vitest";
import { vsSpy } from "@/lib/scout/paper-result";
import { excessReturn, signedReturn } from "@/lib/scout/tracking";

describe("return beyond the market, for longs and shorts", () => {
  it("a short beats the market only by falling more than it", () => {
    // Stock -20%, SPY -6%: the short made 20% and beat the market by 14 points (not 26).
    expect(excessReturn("short", signedReturn("short", 100, 80), -0.06)).toBeCloseTo(0.14);
    // Stock flat while SPY rose 5%: the short made nothing but beat the market by 5 points.
    expect(excessReturn("short", signedReturn("short", 100, 100), 0.05)).toBeCloseTo(0.05);
    // Stock -5% while SPY fell 10%: the short made money but lagged the market.
    expect(excessReturn("short", signedReturn("short", 100, 95), -0.1)).toBeCloseTo(-0.05);
    expect(vsSpy("short", { ret: 0.147, spy: -0.06 })).toBeCloseTo(0.087);
  });

  it("a long is unchanged: return minus the market", () => {
    expect(excessReturn("long", signedReturn("long", 100, 110), 0.04)).toBeCloseTo(0.06);
    expect(vsSpy("long", { ret: 0.1, spy: 0.04 })).toBeCloseTo(0.06);
    expect(vsSpy("long", { ret: 0.1, spy: null })).toBeNull();
  });
});
