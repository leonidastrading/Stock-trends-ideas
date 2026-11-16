import { describe, expect, it } from "vitest";
import { paperResult } from "@/lib/scout/paper-result";
import type { Track } from "@/lib/scout/store";

const base: Track = { cardId: 1, symbol: "AAON", sectorEtf: "XLI", direction: "short", cardDate: "2026-11-14", entryDate: "2026-11-16", entryPrice: 80, spyEntry: 600, sectorEntry: null, deadlineDate: "2027-02-12", exitDate: null, exitPrice: null, spyExit: null, sectorExit: null, exitReason: null, maxDrawdownPct: null, tappedAt: null, swingResponse: null };

describe("paper result on a card", () => {
  it("open short: live price, direction-adjusted, against SPY", () => {
    const r = paperResult(base, 72, 612, new Date("2026-12-16T18:00:00Z"))!;
    expect(r.closed).toBe(false);
    expect(r.ret).toBeCloseTo(0.1); // the stock fell 10%: +10% on a short
    expect(r.spy).toBeCloseTo(0.02);
    expect(r.days).toBe(30);
  });

  it("closed long: uses the logged exit and SPY's exit", () => {
    const r = paperResult({ ...base, direction: "long", exitDate: "2027-01-15", exitPrice: 88, spyExit: 594 }, 50, 700)!;
    expect(r).toMatchObject({ closed: true });
    expect(r.ret).toBeCloseTo(0.1);
    expect(r.spy).toBeCloseTo(-0.01);
  });

  it("nothing before entry", () => {
    expect(paperResult({ ...base, entryDate: null, entryPrice: null }, 72, 612)).toBeNull();
  });
});
