import { describe, expect, it } from "vitest";
import { fiscalYears, largestCompanies, listChanges, listPlaces, withAlsoRead, longTermChecks, passesAll, priceOf, removedSector, reportingCurrency, screen, usListed, type FiscalYear, type LongTermRow } from "@/lib/scout/long-term";
import { periodFacts } from "@/lib/sources/fmp";

const yr = (y: number, o: Partial<FiscalYear>): FiscalYear => ({ end: `${y}-12-31`, netIncome: 0, revenue: null, equity: null, debt: null, cashFromOps: null, capex: null, shares: null, ...o });
/** A quality compounder: profit grows 9% a year on a 20% margin, equity of about four years' profit, little debt. */
const good = (n = 7): FiscalYear[] => Array.from({ length: n }, (_, i) => {
  const ni = 1000 * 1.09 ** i;
  return yr(2019 + i, { netIncome: ni, revenue: ni * 5, equity: 4000 * 1.09 ** i, debt: 1000, shares: 500 });
});
const by = (r: NonNullable<ReturnType<typeof longTermChecks>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));

describe("the five checks", () => {
  it("pass a company with a high return on equity, a fat margin, little debt and higher profit than five years ago", () => {
    const r = longTermChecks(good())!;
    expect(by(r)).toEqual({ roe_last: true, roe_5y: true, margin: true, debt: true, growth: true });
    expect(passesAll(r.checks)).toBe(true);
    // Net income over the average of opening and closing equity.
    expect(r.metrics.roeLast).toBeCloseTo((1000 * 1.09 ** 6) / ((4000 * 1.09 ** 6 + 4000 * 1.09 ** 5) / 2) * 100, 1);
    expect(r.metrics.roe5y).toBeCloseTo(26.1, 1);
    expect(r.metrics.margin).toBe(20);
    expect(r.metrics.debtToEquity).toBeCloseTo(1000 / (4000 * 1.09 ** 6), 2);
    expect(r.metrics.year5yAgo).toBe("2020-12-31");
  });

  it("fail each rule on its own", () => {
    const base = good();
    const last = base.length - 1;
    const withLast = (o: Partial<FiscalYear>) => base.map((y, i) => (i === last ? { ...y, ...o } : y));
    // Return on equity under 20% last year only (equity doubled by a share issue at the year end).
    expect(by(longTermChecks(withLast({ equity: base[last].equity! * 3 }))!)).toMatchObject({ roe_last: false, roe_5y: true });
    // Margin under 15%.
    expect(by(longTermChecks(withLast({ revenue: base[last].netIncome! * 10 }))!)).toMatchObject({ margin: false });
    // Long-term debt above half of equity: asked of everyone.
    expect(by(longTermChecks(withLast({ debt: base[last].equity! * 0.51 }))!)).toMatchObject({ debt: false });
    expect(by(longTermChecks(withLast({ debt: base[last].equity! * 0.5 }))!)).toMatchObject({ debt: true });
    // Net income not above five years earlier.
    expect(by(longTermChecks(base.map((y, i) => (i === 1 ? { ...y, netIncome: 99_999 } : y)))!)).toMatchObject({ growth: false });
    // A weak five-year average with a strong last year.
    const lateBloomer = base.map((y, i) => (i < last ? { ...y, netIncome: y.netIncome! * 0.3 } : y));
    expect(by(longTermChecks(lateBloomer)!)).toMatchObject({ roe_last: true, roe_5y: false });
  });

  it("do not pass a check that cannot be made", () => {
    // Four fiscal years: no five-year average, no year five years back.
    const short = longTermChecks(good(4))!;
    expect(by(short)).toMatchObject({ roe_5y: null, growth: null });
    expect(passesAll(short.checks)).toBe(false);
    // Equity below zero after buybacks: the return cannot be measured and the debt rule fails.
    const hollow = longTermChecks(good().map((y, i) => (i >= 5 ? { ...y, equity: -500 } : y)))!;
    expect(by(hollow)).toMatchObject({ roe_last: null, roe_5y: null, debt: false });
    // No sales on file, or net income larger than the sales line found.
    expect(by(longTermChecks(good().map((y) => ({ ...y, revenue: null })))!).margin).toBeNull();
    expect(by(longTermChecks(good().map((y) => ({ ...y, revenue: y.netIncome! / 2 })))!).margin).toBeNull();
    expect(longTermChecks([])).toBeNull();
  });

  it("read no long-term debt line as no debt", () => {
    const r = longTermChecks(good().map((y) => ({ ...y, debt: null })))!;
    expect(r.checks.find((c) => c.id === "debt")).toEqual({ id: "debt", pass: true, detail: "no long-term debt reported" });
    expect(r.metrics.debtToEquity).toBe(0);
  });

  it("need five fiscal years in a row for the average", () => {
    const gap = good().filter((_, i) => i !== 4);
    expect(by(longTermChecks(gap)!).roe_5y).toBeNull();
  });
});

describe("removed sectors, from the SEC's industry code", () => {
  it("removes energy, utilities, real estate and basic materials", () => {
    const energy = ["1311", "1381", "2911", "4610", "4922", "3533", "6792", "1221"], utilities = ["4911", "4931", "4924", "4941", "4991"], estate = ["6798", "6500", "6552"], materials = ["1040", "1400", "2810", "2851", "2870", "3312", "3334", "2621", "3270"];
    for (const c of energy) expect(removedSector(c)).toBe("energy");
    for (const c of utilities) expect(removedSector(c)).toBe("utilities");
    for (const c of estate) expect(removedSector(c)).toBe("real estate");
    for (const c of materials) expect(removedSector(c)).toBe("basic materials");
  });
  it("keeps everything else, including look-alikes", () => {
    // Software, chips, drugs, soap and cosmetics, waste haulers, homebuilders, banks, fibre and cable makers, packaging.
    for (const c of ["7372", "3674", "2834", "2840", "2844", "4953", "1531", "6021", "3357", "2650", "3559", "", null, "abc"]) expect(removedSector(c)).toBeNull();
  });
});

describe("the pool and the final list", () => {
  const row = (symbol: string, rank: number, roe5y: number, o: Partial<LongTermRow> & { price?: number | null; exchanges?: Array<string | null>; fail?: boolean } = {}): LongTermRow => {
    const r = longTermChecks(good())!;
    const checks = o.fail ? r.checks.map((c) => (c.id === "margin" ? { ...c, pass: false } : c)) : r.checks;
    return { symbol, name: symbol, rank, computedAt: "2026-11-27T00:00:00Z", metrics: { ...r.metrics, roe5y, price: o.price === undefined ? 100 : o.price, exchanges: o.exchanges ?? ["Nasdaq"] }, checks, removed: o.removed ?? null, error: null };
  };
  it("is the largest listed companies, minus cheap shares and removed sectors, ranked by five-year return on equity", () => {
    const s = screen([
      row("AAA", 1, 30), row("BBB", 2, 45), row("PENNY", 3, 60, { price: 4.99 }), row("OIL", 4, 70, { removed: "energy" }), row("THIN", 5, 80, { fail: true }),
      row("OTCQX", 6, 90, { exchanges: ["OTC"] }), row("NOPX", 7, 25, { price: null }), { symbol: "FUND", name: "Fund", rank: 8, computedAt: "2026-11-27T00:00:00Z", metrics: null, checks: [], removed: null, error: "no annual reports" },
    ]);
    expect(s.pool.map((r) => r.symbol)).toEqual(["AAA", "BBB", "PENNY", "OIL", "THIN", "NOPX"]);
    expect(s.underPrice.map((r) => r.symbol)).toEqual(["PENNY"]);
    expect(s.removedSector.map((r) => r.symbol)).toEqual(["OIL"]);
    expect(s.checked).toBe(4);
    expect(s.failed.margin).toBe(1);
    // A company with no price from the feed stays in.
    expect(s.passers.map((r) => r.symbol)).toEqual(["BBB", "AAA", "NOPX"]);
  });
  it("keeps the top 25 and takes the 1,000 largest only", () => {
    const many = Array.from({ length: 1010 }, (_, i) => row(`S${i}`, i + 1, 20 + (i % 97)));
    const s = screen(many);
    expect(s.pool).toHaveLength(1000);
    expect(s.top).toHaveLength(25);
    expect(s.top[0].metrics!.roe5y).toBe(116);
    expect(s.pool.some((r) => r.symbol === "S1005")).toBe(false);
  });
  it("names what a re-run would change in the kept list", () => {
    const kept = [{ symbol: "AAA", name: "A", roe5y: 30, roeLast: 30, margin: 20, debtToEquity: 0.1, price: 100 }, { symbol: "OLD", name: "O", roe5y: 28, roeLast: 28, margin: 20, debtToEquity: 0.1, price: 50 }];
    const c = listChanges(kept, [row("AAA", 1, 30), row("NEW", 2, 40)]);
    expect(c.join.map((r) => r.symbol)).toEqual(["NEW"]);
    expect(c.leave.map((p) => p.symbol)).toEqual(["OLD"]);
  });
  it("always reads a company the SEC's list does not carry near the top, and counts it inside the pool (TSMC)", () => {
    const top = [{ symbol: "AAPL", cik: "320193", name: "Apple Inc.", rank: 1 }, { symbol: "MSFT", cik: "789019", name: "MICROSOFT CORP", rank: 2 }];
    expect(withAlsoRead(top).map((c) => [c.symbol, c.rank])).toEqual([["TSM", 0], ["AAPL", 1], ["MSFT", 2]]);
    // Already on the list (by symbol or by SEC number): left where the list has it.
    const has = [...top, { symbol: "TSM", cik: "1046179", name: "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD", rank: 3 }];
    expect(withAlsoRead(has)).toEqual(has);
    const s = screen([row("TSM", 0, 31), row("AAA", 1, 30)]);
    expect(s.pool.map((r) => r.symbol)).toEqual(["TSM", "AAA"]);
    expect(listPlaces([{ cik: "1", ticker: "NVS", title: "Novartis" }, { cik: "2", ticker: "TM", title: "Toyota" }], ["TSM", "TM"])).toBe("TSM absent, TM 2");
  });
  it("counts a company as US-listed unless it only trades over the counter", () => {
    expect(usListed(["Nasdaq"])).toBe(true);
    expect(usListed(["NYSE", "OTC"])).toBe(true);
    expect(usListed(["OTC"])).toBe(false);
    expect(usListed([null])).toBe(true);
    expect(usListed(null)).toBe(true);
  });
  it("reads the largest on the SEC's list, one share class each, without funds or odd symbols", () => {
    const list = [
      { cik: "1045810", ticker: "NVDA", title: "NVIDIA CORP" }, { cik: "1652044", ticker: "GOOGL", title: "Alphabet Inc." }, { cik: "1652044", ticker: "GOOG", title: "Alphabet Inc." },
      { cik: "1067983", ticker: "BRK.B", title: "BERKSHIRE HATHAWAY INC" }, { cik: "884394", ticker: "XLK", title: "SELECT SECTOR SPDR TRUST" }, { cik: "999", ticker: "ABCDEF", title: "Odd Symbol Co" }, { cik: "320193", ticker: "AAPL", title: "Apple Inc." },
    ];
    expect(largestCompanies(list, 3).map((c) => [c.symbol, c.rank])).toEqual([["NVDA", 1], ["GOOGL", 2], ["BRK.B", 3]]);
    expect(largestCompanies(list).map((c) => c.symbol)).toEqual(["NVDA", "GOOGL", "BRK.B", "AAPL"]);
  });
});

describe("the price against last year's profit (for information)", () => {
  it("gives a ratio, and none when the figures do not line up", () => {
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "USD" }, 200)).toBe(20);
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "TWD" }, 200)).toBeNull();
    expect(priceOf({ netIncome: -5, shares: 100, currency: "USD" }, 200)).toBeNull();
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "USD" }, 5000)).toBeNull(); // 500 times: a split since the year end
    expect(priceOf({ netIncome: 1000, shares: null, currency: "USD" }, 200)).toBeNull();
  });
});

describe("fiscal years from the SEC's facts", () => {
  const ann = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
  const at = (y: number, val: number) => ({ end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
  const ys = [2020, 2021, 2022, 2023, 2024, 2025];
  it("lines up each year's income and balance sheet by the year end, and the checks follow", () => {
    const facts = { "us-gaap": {
      NetIncomeLoss: { units: { USD: ys.map((y, i) => ann(y, 100 + i * 10)) } },
      Revenues: { units: { USD: ys.map((y, i) => ann(y, 500 + i * 20)) } },
      StockholdersEquity: { units: { USD: ys.map((y, i) => at(y, 400 + i * 20)) } },
      LongTermDebtNoncurrent: { units: { USD: ys.map((y) => at(y, 200)) } },
      WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: ys.map((y) => ann(y, 50)) } },
    } };
    const out = fiscalYears(facts);
    expect(out).toHaveLength(6);
    expect(out[5]).toMatchObject({ end: "2025-12-31", netIncome: 150, revenue: 600, equity: 500, debt: 200, shares: 50 });
    const r = longTermChecks(out)!;
    expect(by(r)).toEqual({ roe_last: true, roe_5y: true, margin: true, debt: true, growth: true });
    expect(r.metrics.netIncome5yAgo).toBe(100);
  });
  it("reads a foreign company in its own currency, not in the dollar figure it prints beside it (TSMC)", () => {
    const f20 = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "20-F", filed: `${y + 1}-04-15` });
    const i20 = (y: number, val: number) => ({ end: `${y}-12-31`, val, form: "20-F", filed: `${y + 1}-04-15` });
    // Home currency for every year; a dollar convenience figure for the latest years only, listed first.
    const facts = { "ifrs-full": {
      ProfitLossAttributableToOwnersOfParent: { units: { USD: [2024, 2025].map((y) => f20(y, 40)), TWD: ys.map((y, i) => f20(y, 1000 + i * 100)) } },
      Revenue: { units: { USD: [2025].map((y) => f20(y, 100)), TWD: ys.map((y, i) => f20(y, 2500 + i * 200)) } },
      EquityAttributableToOwnersOfParent: { units: { USD: [2025].map((y) => i20(y, 150)), TWD: ys.map((y, i) => i20(y, 3000 + i * 300)) } },
      LongtermBorrowings: { units: { TWD: ys.map((y) => i20(y, 600)) } },
    } };
    expect(reportingCurrency(facts)).toBe("TWD");
    const out = fiscalYears(facts);
    expect(out.at(-1)).toMatchObject({ end: "2025-12-31", netIncome: 1500, revenue: 3500, equity: 4500, debt: 600 });
    const r = longTermChecks(out, reportingCurrency(facts))!;
    expect(by(r)).toEqual({ roe_last: true, roe_5y: true, margin: true, debt: true, growth: true });
    expect(r.metrics.currency).toBe("TWD");
    // A company with the same number of years in both keeps its home currency.
    expect(reportingCurrency({ "ifrs-full": { ProfitLoss: { units: { USD: ys.map((y) => f20(y, 1)), JPY: ys.map((y) => f20(y, 150)) } } } })).toBe("JPY");
    expect(reportingCurrency({ "us-gaap": { NetIncomeLoss: { units: { USD: ys.map((y) => ann(y, 1)) } } } })).toBe("USD");
  });
  it("a fiscal year comes from an annual report, not from the rolling twelve months a quarterly report prints (Amazon)", () => {
    const ttm = (start: string, end: string, val: number) => ({ start, end, val, form: "10-Q", filed: end });
    const rows = [ann(2021, 33), ann(2022, -3), ann(2023, 30), ann(2024, 59), ttm("2024-04-01", "2025-03-31", 65), ttm("2024-07-01", "2025-06-30", 70)];
    expect(periodFacts(rows, "annual", 10).map((r) => r.end)).toEqual(["2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31"]);
  });
  it("long-term debt is the largest debt line the company reports, not the first one found (Marriott read as no debt)", () => {
    const facts = { "us-gaap": {
      NetIncomeLoss: { units: { USD: ys.map((y) => ann(y, 2000)) } },
      LongTermNotesPayable: { units: { USD: ys.map((y) => at(y, 0)) } },
      LongTermDebtAndCapitalLeaseObligations: { units: { USD: ys.map((y) => at(y, 13_000)) } },
    } };
    expect(fiscalYears(facts).at(-1)!.debt).toBe(13_000);
  });
});
