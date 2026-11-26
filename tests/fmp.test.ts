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

import { finnhubEps, secIncome } from "@/lib/sources/fmp";
describe("free fallbacks when FMP's plan does not cover a stock", () => {
  it("reads revenue and net income from the SEC's XBRL facts, IFRS and other currencies included", () => {
    const fy = (end: string, val: number, filed = end) => ({ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, form: "40-F", fp: "FY", filed });
    const facts = { "ifrs-full": {
      Revenue: { units: { CAD: [fy("2024-12-31", 54e9), fy("2025-12-31", 50e9)] } },
      ProfitLoss: { units: { CAD: [fy("2024-12-31", 6e9), fy("2025-12-31", 5.5e9)] } },
    } };
    const r = secIncome(facts, "annual");
    expect(r.currency).toBe("CAD");
    expect(r.rows).toEqual([
      { label: "'24", date: "2024-12-31", revenue: 54e9, netIncome: 6e9, margin: 11.1 },
      { label: "'25", date: "2025-12-31", revenue: 50e9, netIncome: 5.5e9, margin: 11 },
    ]);
    expect(secIncome({}, "annual")).toEqual({ rows: [], currency: null });
  });

  it("reads Finnhub's EPS history and the next estimate", () => {
    const hist = [{ period: "2026-09-30", actual: 1.2, estimate: 1.1 }, { period: "2026-06-30", actual: 1.0, estimate: 1.05 }];
    const next = { earningsCalendar: [{ date: "2027-02-04", epsEstimate: 1.3 }] };
    expect(finnhubEps(hist, next, "2026-11-23")).toEqual([
      { label: "Q2 '26", date: "2026-06-30", actual: 1.0, estimate: 1.05 },
      { label: "Q3 '26", date: "2026-09-30", actual: 1.2, estimate: 1.1 },
      { label: "next", date: "2027-02-04", actual: null, estimate: 1.3 },
    ]);
  });
});

import { incomeCheck, pickRevenue } from "@/lib/sources/fmp";

describe("financials sanity", () => {
  const yr = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-15` });
  it("takes total revenue for an insurer, not its fee line (MetLife showed $3.0B and a 329% margin)", () => {
    const facts = { "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [yr(2024, 2.9e9), yr(2025, 3.0e9)] } },
      Revenues: { units: { USD: [yr(2024, 70e9), yr(2025, 73e9)] } },
      NetIncomeLoss: { units: { USD: [yr(2024, 4.4e9), yr(2025, 9.9e9)] } },
    } };
    expect(pickRevenue(facts, "annual")!.rows.at(-1)!.val).toBe(73e9);
    const r = secIncome(facts, "annual");
    expect(r.rows.at(-1)).toMatchObject({ revenue: 73e9, netIncome: 9.9e9, margin: 13.6 });
    expect(incomeCheck(r.rows)).toBeNull();
  });
  it("adds interest income and non-interest income for a bank with no total line", () => {
    const facts = { "us-gaap": { InterestAndDividendIncomeOperating: { units: { USD: [yr(2025, 8e9)] } }, NoninterestIncome: { units: { USD: [yr(2025, 2e9)] } }, RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [yr(2025, 0.9e9)] } } } };
    expect(pickRevenue(facts, "annual")!.rows.at(-1)!.val).toBe(10e9);
  });
  it("hides everything when net income is above revenue, and only the margin line when the loss dwarfs revenue", () => {
    const row = (label: string, revenue: number, netIncome: number) => ({ label, date: "2025-12-31", revenue, netIncome, margin: Math.round((netIncome / revenue) * 1000) / 10 });
    expect(incomeCheck([row("'25", 3.0e9, 9.9e9)])).toMatchObject({ hide: "all" });
    expect(incomeCheck([row("'25", 1e6, -50e6)])).toMatchObject({ hide: "margin" });
    expect(incomeCheck([row("'25", 100, 20), row("'24", 100, -80)])).toBeNull();
  });
});

