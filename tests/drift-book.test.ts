import { describe, expect, it } from "vitest";
import { bookStats } from "@/app/drift/DriftBook";

describe("down-drift scoreboard", () => {
  it("win rate and mean/median excess over SPY, from closed shorts", () => {
    const s = bookStats([{ ret: 0.05, spy: 0.01 }, { ret: -0.02, spy: 0.01 }, { ret: 0.1, spy: -0.02 }, { ret: 0.03, spy: null }]);
    expect(s.n).toBe(3);
    expect(s.wins).toBe(2);
    // Shorts: excess = SPY's move minus the stock's = the short's return plus SPY's move.
    expect(s.mean).toBeCloseTo((0.06 - 0.01 + 0.08) / 3);
    expect(s.median).toBeCloseTo(0.06);
    expect(bookStats([])).toEqual({ n: 0, wins: 0, mean: null, median: null });
  });
});

import { entryDay } from "@/app/drift/DriftBook";
describe("when a not-yet-entered short enters", () => {
  it("the next weekday open", () => {
    expect(entryDay("2026-11-20", "2026-11-22")).toBe("2026-11-23"); // card Friday, today Sunday → Monday
    expect(entryDay("2026-11-22", "2026-11-22")).toBe("2026-11-23");
    expect(entryDay("2026-11-23", "2026-11-23")).toBe("2026-11-24");
    expect(entryDay("2026-11-20", "2026-11-23", true)).toBe("2026-11-23"); // Monday before 9:30: today's open
  });
});
