import { describe, expect, it } from "vitest";
import { baselinePercentile, groupStats, mulberry32, type IdeaResult } from "@/lib/scout/scoring";

const idea = (p: Partial<IdeaResult>): IdeaResult => ({
  cardId: 1, origin: "scout", tapped: false, kind: "consumer", status: "promoted", rankScore: 50, symbol: "X", direction: "long", entryDate: "2026-01-02", exitDate: "2026-02-02", closed: true,
  ret: 0.05, spyRet: 0.01, sectorRet: 0.02, excess: 0.04, excessSector: 0.03, maxDrawdownPct: -3, baseline: [0.01, -0.02, 0.0], ...p,
});

describe("scoring", () => {
  it("group stats over closed ideas only", () => {
    const s = groupStats([idea({}), idea({ cardId: 2, excess: -0.02, ret: -0.01, maxDrawdownPct: -5 }), idea({ cardId: 3, closed: false, exitDate: null })]);
    expect(s).toMatchObject({ n: 3, closed: 2, winRateVsSpy: 0.5, avgDrawdownPct: -4 });
    expect(s.avgExcess).toBeCloseTo(0.01);
    expect(s.medianExcess).toBeCloseTo(0.01);
    expect(groupStats([]).winRateVsSpy).toBeNull();
  });
  it("baseline percentile is deterministic and sits where expected", () => {
    const ideas = Array.from({ length: 10 }, (_, i) => idea({ cardId: i, excess: 0.05, baseline: [0.01, -0.01, 0.0] }));
    const b = baselinePercentile(ideas);
    expect(b.trials).toBe(1000);
    expect(b.percentileOfActual).toBe(1);
    expect(b.mean!).toBeCloseTo(0, 2);
    expect(baselinePercentile(ideas).mean).toBe(b.mean);
    const worse = baselinePercentile(ideas.map((i) => ({ ...i, excess: -0.05 })));
    expect(worse.percentileOfActual).toBe(0);
  });
  it("mulberry32 is seeded", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
