import { describe, expect, it } from "vitest";
import { money, ticks } from "@/components/CardFundamentals";
import { parseEarnings, parseIncome } from "@/lib/sources/fmp";

describe("card financials (Financial Modeling Prep)", () => {
  it("reads the income statement oldest first with net margin, annual and quarterly", () => {
    const annual = [
      { date: "2025-09-27", fiscalYear: "2025", period: "FY", revenue: 21_000_000_000, netIncome: 1_520_000_000 },
      { date: "2024-09-28", fiscalYear: "2024", period: "FY", revenue: 20_000_000_000, netIncome: 1_380_000_000 },
    ];
    expect(parseIncome(annual, "annual")).toEqual([
      { label: "'24", date: "2024-09-28", revenue: 20e9, netIncome: 1.38e9, margin: 6.9 },
      { label: "'25", date: "2025-09-27", revenue: 21e9, netIncome: 1.52e9, margin: 7.2 },
    ]);
    // The older v3 shape: calendarYear, string numbers, no fiscalYear.
    expect(parseIncome([{ date: "2026-06-30", calendarYear: "2026", period: "Q2", revenue: "5000000000", netIncome: "-250000000" }], "quarter")[0]).toMatchObject({ label: "Q2 '26", margin: -5 });
    expect(parseIncome({ "Error Message": "x" }, "annual")).toEqual([]);
  });

  it("keeps the last four reported quarters and the next estimate", () => {
    const rows = [
      { date: "2027-02-10", epsActual: null, epsEstimated: 3.2 },
      { date: "2026-11-05", epsActual: 3.3, epsEstimated: 2.95 },
      { date: "2026-08-05", epsActual: 3.1, epsEstimated: 2.8 },
      { date: "2026-05-05", epsActual: 2.7, epsEstimated: 2.5 },
      { date: "2026-02-05", epsActual: 2.85, epsEstimated: 2.75 },
      { date: "2025-11-05", epsActual: 2.6, epsEstimated: 2.6 },
    ];
    const e = parseEarnings(rows, "2026-11-23");
    expect(e.map((r) => r.label)).toEqual(["Q1 '26", "Q2 '26", "Q3 '26", "Q4 '26", "Q1 '27"]);
    expect(e[4]).toMatchObject({ actual: null, estimate: 3.2 });
    // The v3 shape: eps / epsEstimated.
    expect(parseEarnings([{ date: "2026-08-05", eps: 1.1, epsEstimated: 1 }], "2026-11-23")[0]).toMatchObject({ actual: 1.1, estimate: 1 });
  });

  it("labels money and picks round axis ticks", () => {
    expect(money(23_400_000_000)).toBe("23.4B");
    expect(money(-45_000_000)).toBe("−45M");
    expect(ticks(0, 24e9)).toEqual([0, 1e10, 2e10, 3e10]);
    expect(ticks(-5, 8)).toEqual([-5, 0, 5, 10]);
  });
});
