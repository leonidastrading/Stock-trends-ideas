import { describe, expect, it } from "vitest";
import { bySlot, rankReports, weekDays, weekMonday } from "@/lib/scout/earnings-calendar";
import type { EarningsReport } from "@/lib/sources/earnings-data";

const rep = (symbol: string, marketCap: number | null, timing: EarningsReport["timing"] = "before_open"): EarningsReport => ({ symbol, name: symbol, reportDate: "2026-11-23", timing, epsActual: null, epsEstimate: 1, marketCap, quarterEnd: null, lastYearEps: null, estimates: null });

describe("earnings calendar", () => {
  it("shows the current week on weekdays and the coming week on weekends", () => {
    expect(weekMonday("2026-11-23")).toBe("2026-11-23"); // Monday
    expect(weekMonday("2026-11-27")).toBe("2026-11-23"); // Friday
    expect(weekMonday("2026-11-28")).toBe("2026-11-30"); // Saturday
    expect(weekMonday("2026-11-29")).toBe("2026-11-30"); // Sunday
    expect(weekDays("2026-11-30")).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]);
  });

  it("ranks by size, lifting trending and carded stocks", () => {
    const r = rankReports([rep("SMALL", 2e9), rep("BIG", 500e9), rep("HYPE", 3e9), rep("NONE", null)], new Set(["HYPE"]), new Set());
    expect(r.map((x) => x.symbol)).toEqual(["BIG", "HYPE", "SMALL", "NONE"]);
    expect(r[1].trending).toBe(true);
    expect(rankReports([rep("A", 1e9), rep("B", 5e9)], new Set(), new Set(["A"]))[0].symbol).toBe("A"); // 9 + 1 beats 9.7
  });

  it("splits a day by timing", () => {
    const s = bySlot([rep("A", 1, "before_open"), rep("B", 1, "after_close"), rep("C", 1, "unknown")]);
    expect([s.before_open.length, s.after_close.length, s.unknown.length]).toEqual([1, 1, 1]);
  });
});

describe("share classes", () => {
  it("keeps one line per company", () => {
    const a = { ...rep("CENT", 2.8e9), name: "Central Garden & Pet Company" }, b = { ...rep("CENTA", 2.8e9), name: "Central Garden & Pet Company" };
    expect(rankReports([a, b, rep("ZM", 24e9)], new Set(), new Set()).map((x) => x.symbol)).toEqual(["ZM", "CENT"]);
  });
});
