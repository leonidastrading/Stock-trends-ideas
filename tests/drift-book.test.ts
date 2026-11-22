import { describe, expect, it } from "vitest";
import { bookStats } from "@/app/drift/DriftBook";

describe("down-drift scoreboard", () => {
  it("win rate and mean/median excess over SPY, from closed shorts", () => {
    const s = bookStats([{ ret: 0.05, spy: 0.01 }, { ret: -0.02, spy: 0.01 }, { ret: 0.1, spy: -0.02 }, { ret: 0.03, spy: null }]);
    expect(s.n).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.mean).toBeCloseTo((0.04 - 0.03 + 0.12) / 3);
    expect(s.median).toBeCloseTo(0.04);
    expect(bookStats([])).toEqual({ n: 0, wins: 0, mean: null, median: null });
  });
});
