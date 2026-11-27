import { describe, expect, it } from "vitest";
import { fiscalYears, longTermChecks, priceOf, splitFreeShares, verdictOf, type FiscalYear } from "@/lib/scout/long-term";

const yr = (y: number, o: Partial<FiscalYear>): FiscalYear => ({ end: `${y}-12-31`, netIncome: 0, revenue: null, equity: null, debt: null, cashFromOps: null, capex: null, shares: null, ...o });
/** A steady compounder: profit grows 9% a year on a 20% margin, equity grows with it, little debt, shares shrink. */
const steady = (n = 8): FiscalYear[] => Array.from({ length: n }, (_, i) => {
  const ni = 1000 * 1.09 ** i;
  return yr(2018 + i, { netIncome: ni, revenue: ni * 5, equity: 4000 * 1.06 ** i, debt: 1500, cashFromOps: ni * 1.2, capex: -ni * 0.25, shares: 500 * 0.98 ** i });
});
const by = (r: NonNullable<ReturnType<typeof longTermChecks>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));

describe("the long-term checks", () => {
  it("pass a steady, cash-rich, lightly indebted company that buys itself back", () => {
    const r = longTermChecks(steady(), "consumer_staples")!;
    expect(by(r)).toEqual({ returns: true, profitable: true, growth: true, debt: true, cash: true, margin: true, dilution: true });
    expect(verdictOf(r.checks)).toEqual({ verdict: "passes", passed: 7, asked: 7 });
    expect(r.metrics.growthPct).toBeCloseTo(9, 0);
    expect(r.metrics.avgMargin).toBe(20);
    expect(r.metrics.sharesPct5y).toBeLessThan(0);
    expect(r.metrics.debtYears).toBeLessThan(1.5);
  });

  it("fail a loss year, heavy debt and dilution, and name each", () => {
    const ys = steady().map((y, i) => ({ ...y, netIncome: i === 3 ? -200 : y.netIncome, debt: 20_000, shares: 500 * 1.05 ** i }));
    const r = longTermChecks(ys, "industrials")!;
    expect(by(r)).toMatchObject({ profitable: false, debt: false, dilution: false });
    expect(r.checks.find((c) => c.id === "profitable")!.detail).toBe("a loss in 2021");
    expect(verdictOf(r.checks).verdict).toBe("no");
  });

  it("do not ask a bank about debt, free cash or margin, and set it a lower bar for return on equity", () => {
    const ys = steady().map((y) => ({ ...y, equity: y.netIncome! * 8.5, debt: 50_000, cashFromOps: null, capex: null }));
    const r = longTermChecks(ys, "financials")!;
    expect(by(r)).toMatchObject({ returns: true, debt: null, cash: null, margin: null });
    expect(verdictOf(r.checks)).toMatchObject({ verdict: "passes", asked: 4 });
  });

  it("leave return on equity unmeasured when buybacks have taken equity below zero", () => {
    const ys = steady().map((y, i) => ({ ...y, equity: i > 4 ? -500 : y.equity }));
    const r = longTermChecks(ys, "consumer_discretionary")!;
    expect(by(r).returns).toBeNull();
    expect(verdictOf(r.checks)).toMatchObject({ verdict: "passes", asked: 6 });
  });

  it("need five fiscal years", () => {
    expect(longTermChecks(steady(4), "technology")).toBeNull();
  });

  it("is one short when a single check is missed", () => {
    const ys = steady().map((y) => ({ ...y, revenue: y.netIncome! * 20 })); // a 5% margin
    const v = verdictOf(longTermChecks(ys, "consumer_staples")!.checks);
    expect(v).toEqual({ verdict: "one short", passed: 6, asked: 7 });
  });
});

describe("share counts and stock splits", () => {
  it("takes a split out, so only real issuance or buybacks show", () => {
    const s = splitFreeShares([100, 98, 96, 960, 940]); // a 10-for-1 split in the fourth year
    expect(s[3]).toBeCloseTo(96, 5);
    expect(s[4]).toBeCloseTo(94, 5);
    expect(splitFreeShares([100, 104, null, 108])).toEqual([100, 104, null, 108]);
  });
});

describe("the price against last year's profit", () => {
  it("tags fair, full and expensive, and refuses figures that do not line up", () => {
    const m = { netIncome: 1000, freeCash: 900, shares: 100, currency: "USD" };
    expect(priceOf(m, 200)).toEqual({ pe: 20, earningsYieldPct: 5, freeCashYieldPct: 4.5, tag: "fair" });
    expect(priceOf(m, 300).tag).toBe("full");
    expect(priceOf(m, 400).tag).toBe("expensive");
    expect(priceOf(m, 5000).tag).toBe("unknown"); // 500 times profit: a split since the year end, not a price
    expect(priceOf({ ...m, currency: "JPY" }, 200).tag).toBe("unknown"); // profit in yen against a dollar price
    expect(priceOf({ ...m, netIncome: -5 }, 200).pe).toBeNull();
    expect(priceOf(m, null).tag).toBe("unknown");
  });
});

describe("fiscal years from the SEC's facts", () => {
  it("lines up each year's income, balance sheet and cash flow by the year end", () => {
    const ann = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
    const at = (y: number, val: number) => ({ end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
    const ys = [2021, 2022, 2023, 2024, 2025];
    const facts = { "us-gaap": {
      NetIncomeLoss: { units: { USD: ys.map((y, i) => ann(y, 100 + i * 10)) } },
      Revenues: { units: { USD: ys.map((y, i) => ann(y, 1000 + i * 50)) } },
      StockholdersEquity: { units: { USD: ys.map((y, i) => at(y, 500 + i * 20)) } },
      LongTermDebtNoncurrent: { units: { USD: ys.map((y) => at(y, 200)) } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: ys.map((y, i) => ann(y, 130 + i * 10)) } },
      PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: ys.map((y) => ann(y, 30)) } },
      WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: ys.map((y) => ann(y, 50)) } },
      EarningsPerShareDiluted: { units: { "USD/shares": ys.map((y, i) => ann(y, 2 + i * 0.2)) } },
    } };
    const out = fiscalYears(facts);
    expect(out).toHaveLength(5);
    expect(out[4]).toEqual({ end: "2025-12-31", netIncome: 140, revenue: 1200, equity: 580, debt: 200, cashFromOps: 170, capex: 30, shares: 50 });
    const r = longTermChecks(out, "technology")!;
    expect(r.metrics.avgRoe).toBeGreaterThan(20);
    expect(r.metrics.freeCash).toBe(140);
  });
});

import { periodFacts } from "@/lib/sources/fmp";

describe("what the first live run showed", () => {
  it("a fiscal year comes from an annual report, not from the rolling twelve months a quarterly report prints (Amazon)", () => {
    const fy = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-02` });
    const ttm = (start: string, end: string, val: number) => ({ start, end, val, form: "10-Q", filed: end });
    const rows = [fy(2021, 33), fy(2022, -3), fy(2023, 30), fy(2024, 59), ttm("2024-04-01", "2025-03-31", 65), ttm("2024-07-01", "2025-06-30", 70), ttm("2024-10-01", "2025-09-30", 76)];
    expect(periodFacts(rows, "annual", 10).map((r) => r.end)).toEqual(["2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31"]);
    // A company with no annual-report rows on file is left as it was.
    expect(periodFacts(rows.slice(4), "annual", 10)).toHaveLength(3);
  });
  it("shows no return on equity when buybacks have left almost no equity (O'Reilly read 290%)", () => {
    const ys = steady().map((y, i) => ({ ...y, equity: i > 4 ? 60 : y.equity }));
    const r = longTermChecks(ys, "consumer_discretionary")!;
    expect(r.checks.find((c) => c.id === "returns")).toMatchObject({ pass: null });
    expect(r.metrics.avgRoe).toBeNull();
  });
});

import { kindFromFacts, largestCompanies } from "@/lib/scout/long-term";

describe("the companies screened", () => {
  it("are the largest on the SEC's list, one share class each, without funds or odd symbols", () => {
    const list = [
      { cik: "1045810", ticker: "NVDA", title: "NVIDIA CORP" }, { cik: "1652044", ticker: "GOOGL", title: "Alphabet Inc." }, { cik: "1652044", ticker: "GOOG", title: "Alphabet Inc." },
      { cik: "1067983", ticker: "BRK.B", title: "BERKSHIRE HATHAWAY INC" }, { cik: "884394", ticker: "XLK", title: "SELECT SECTOR SPDR TRUST" }, { cik: "999", ticker: "ABCDEF", title: "Odd Symbol Co" }, { cik: "320193", ticker: "AAPL", title: "Apple Inc." },
    ];
    expect(largestCompanies(list, 3).map((c) => [c.symbol, c.rank])).toEqual([["NVDA", 1], ["GOOGL", 2], ["BRK.B", 3]]);
    expect(largestCompanies(list).map((c) => c.symbol)).toEqual(["NVDA", "GOOGL", "BRK.B", "AAPL"]);
  });
  it("tells a bank or insurer and a property trust from what they report", () => {
    const f = (names: string[]) => ({ "us-gaap": Object.fromEntries(names.map((n) => [n, { units: { USD: [{ end: "2025-12-31", val: 1 }] } }])) });
    expect(kindFromFacts(f(["InterestAndDividendIncomeOperating", "Deposits", "NetIncomeLoss"]))).toBe("financials");
    expect(kindFromFacts(f(["PremiumsEarnedNet", "PolicyholderBenefitsAndClaimsIncurredNet"]))).toBe("financials");
    expect(kindFromFacts(f(["RealEstateInvestmentPropertyNet", "Revenues"]))).toBe("real_estate");
    expect(kindFromFacts(f(["Revenues", "NetIncomeLoss", "Deposits"]))).toBeNull(); // one bank-like line is not a bank
  });
});

describe("long-term debt", () => {
  it("is the largest debt line the company reports, not the first one found (Marriott read as no debt)", () => {
    const ann = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
    const at = (y: number, val: number) => ({ end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
    const ys = [2021, 2022, 2023, 2024, 2025];
    const facts = { "us-gaap": {
      NetIncomeLoss: { units: { USD: ys.map((y) => ann(y, 2000)) } },
      LongTermNotesPayable: { units: { USD: ys.map((y) => at(y, 0)) } },
      LongTermDebtAndCapitalLeaseObligations: { units: { USD: ys.map((y) => at(y, 13_000)) } },
    } };
    expect(fiscalYears(facts).at(-1)!.debt).toBe(13_000);
  });
});
