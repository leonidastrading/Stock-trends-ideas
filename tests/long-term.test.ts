import { describe, expect, it } from "vitest";
import {
  debtAt, filingFacts, firstTradingDayOfJanuary, fiscalYears, largestCompanies, listChanges, listingAge, listPlaces, longTermChecks, marketValueOf, passesAll, priceOf, readState,
  removedSector, reportingCurrency, reportLine, screen, SECTOR_CODES, standing, usListed, withAlsoRead, yearsBack, type FiscalYear, type LongTermRow,
} from "@/lib/scout/long-term";
import { periodFacts } from "@/lib/sources/fmp";

const yr = (y: number, o: Partial<FiscalYear>): FiscalYear => ({ end: `${y}-12-31`, netIncome: 0, revenue: null, equity: null, debt: null, shares: null, ...o });
/** A quality compounder: profit grows 9% a year on a 20% margin, equity of about four years' profit, little debt. */
const good = (n = 7): FiscalYear[] => Array.from({ length: n }, (_, i) => {
  const ni = 1000 * 1.09 ** i;
  return yr(2019 + i, { netIncome: ni, revenue: ni * 5, equity: 4000 * 1.09 ** i, debt: 1000, debtFrom: "LongTermDebtNoncurrent", debtKind: "noncurrent total", operatingIncome: ni * 1.25, shares: 500 });
});
const by = (r: NonNullable<ReturnType<typeof longTermChecks>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));
const why = (r: NonNullable<ReturnType<typeof longTermChecks>>, id: string) => r.checks.find((c) => c.id === id)!.detail;
const lastOf = (ys: FiscalYear[], o: Partial<FiscalYear>) => ys.map((y, i) => (i === ys.length - 1 ? { ...y, ...o } : y));

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
    expect(r.metrics.oneOff).toEqual([]);
    expect(why(r, "debt")).toMatch(/^long-term debt is 15% of equity \(LongTermDebtNoncurrent\)/);
  });

  it("fail each rule on its own", () => {
    const base = good();
    const e = base.at(-1)!.equity!, ni = base.at(-1)!.netIncome!;
    // Return on equity under 20% last year only (equity tripled by a share issue at the year end).
    expect(by(longTermChecks(lastOf(base, { equity: e * 3 }))!)).toMatchObject({ roe_last: false, roe_5y: true });
    // Margin under 15%.
    expect(by(longTermChecks(lastOf(base, { revenue: ni * 10 }))!)).toMatchObject({ margin: false });
    // Long-term debt above half of equity: asked of everyone.
    expect(by(longTermChecks(lastOf(base, { debt: e * 0.51 }))!)).toMatchObject({ debt: false });
    expect(by(longTermChecks(lastOf(base, { debt: e * 0.5 }))!)).toMatchObject({ debt: true });
    // Net income not above five years earlier.
    expect(by(longTermChecks(base.map((y, i) => (i === 1 ? { ...y, netIncome: 99_999 } : y)))!)).toMatchObject({ growth: false });
    // A weak five-year average with a strong last year.
    const lateBloomer = base.map((y, i) => (i < base.length - 1 ? { ...y, netIncome: y.netIncome! * 0.3 } : y));
    expect(by(longTermChecks(lateBloomer)!)).toMatchObject({ roe_last: true, roe_5y: false });
  });
});

describe("a check with a missing input fails", () => {
  it("fails, and says which input is missing", () => {
    // Four fiscal years: no five-year average, no year five years back.
    const short = longTermChecks(good(4))!;
    expect(by(short)).toMatchObject({ roe_5y: false, growth: false });
    expect(why(short, "roe_5y")).toBe("fewer than 5 fiscal years in a row on file");
    expect(why(short, "growth")).toBe("no fiscal year 5 years before 2022 on file");
    // No sales on file, or net income larger than the sales line found.
    const noSales = longTermChecks(good().map((y) => ({ ...y, revenue: null })))!;
    expect(by(noSales).margin).toBe(false);
    expect(why(noSales, "margin")).toBe("sales are not in the report");
    expect(by(longTermChecks(good().map((y) => ({ ...y, revenue: y.netIncome! / 2 })))!).margin).toBe(false);
    // Equity missing from the latest report.
    const noEquity = longTermChecks(lastOf(good(), { equity: null }))!;
    expect(by(noEquity)).toMatchObject({ roe_last: false, roe_5y: false, debt: false });
    // A gap in the five years.
    expect(by(longTermChecks(good().filter((_, i) => i !== 4))!).roe_5y).toBe(false);
    expect(longTermChecks([])).toBeNull();
  });

  it("never reads a missing debt line as no debt (Ameriprise showed 'none' with billions of debt)", () => {
    // A broker or insurer: no debt line found, and liabilities not split by when they fall due.
    const r = longTermChecks(good().map((y) => ({ ...y, debt: null, debtFrom: null, debtKind: null })))!;
    expect(by(r).debt).toBe(false);
    expect(why(r, "debt")).toBe("no long-term debt figure found in the filing, and its liabilities are not split by when they fall due");
    expect(r.metrics.debtToEquity).toBeNull();
    expect(passesAll(r.checks)).toBe(false);
  });

  it("shows 'none' only for a debt line the filing reports as zero", () => {
    const r = longTermChecks(lastOf(good(), { debt: 0, debtFrom: "LongTermDebtNoncurrent" }))!;
    expect(by(r).debt).toBe(true);
    expect(why(r, "debt")).toBe("the filing reports no long-term debt (LongTermDebtNoncurrent is zero)");
    expect(r.metrics.debt).toBe(0);
  });

  it("with no debt line, passes only when everything owed beyond a year is within the limit", () => {
    const e = good().at(-1)!.equity!;
    const within = longTermChecks(lastOf(good(), { debt: null, debtFrom: null, noncurrentLiabilities: e * 0.3 }))!;
    expect(by(within).debt).toBe(true);
    expect(within.metrics).toMatchObject({ debt: null, debtToEquity: null, debtCeiling: 0.3 });
    expect(why(within, "debt")).toBe("no long-term debt line in the filing; everything owed beyond a year is 30% of equity, so long-term debt is within the limit");
    const over = longTermChecks(lastOf(good(), { debt: null, debtFrom: null, noncurrentLiabilities: e * 0.8 }))!;
    expect(by(over).debt).toBe(false);
    expect(why(over, "debt")).toMatch(/so the limit cannot be confirmed$/);
  });

  it("fails both return checks and the debt check when equity is at or below zero now or in a year of the average (Fortinet, Ubiquiti)", () => {
    const now = longTermChecks(lastOf(good(), { equity: -500 }))!;
    expect(by(now)).toMatchObject({ roe_last: false, roe_5y: false, debt: false, margin: true, growth: true });
    expect(why(now, "debt")).toBe("shareholders' equity is at or below zero in 2025");
    // Negative two and three years ago, positive again now: the latest year's own figure does not rescue it.
    const earlier = longTermChecks(good().map((y, i) => (i === 3 || i === 4 ? { ...y, equity: -300 } : y)))!;
    expect(by(earlier)).toMatchObject({ roe_last: false, roe_5y: false, debt: false });
    expect(why(earlier, "roe_last")).toBe("shareholders' equity was at or below zero in 2022, 2023");
    expect(earlier.metrics.roeLast).not.toBeNull();
    // Zero counts as well.
    expect(by(longTermChecks(lastOf(good(), { equity: 0 }))!)).toMatchObject({ roe_last: false, roe_5y: false, debt: false });
  });
});

describe("the one-off gain tag", () => {
  it("is on when net income is more than 1.5 times operating income", () => {
    const ni = good().at(-1)!.netIncome!;
    expect(longTermChecks(lastOf(good(), { operatingIncome: ni / 2 }))!.metrics.oneOff).toEqual(["net income is 2 times operating income"]);
    expect(longTermChecks(lastOf(good(), { operatingIncome: -50 }))!.metrics.oneOff).toEqual(["net income is positive while operations made a loss"]);
    expect(longTermChecks(lastOf(good(), { operatingIncome: ni / 1.4 }))!.metrics.oneOff).toEqual([]);
    // Operating income not reported (banks, insurers): no tag from that rule.
    expect(longTermChecks(lastOf(good(), { operatingIncome: null }))!.metrics.oneOff).toEqual([]);
  });
  it("is on when last year's return on equity is more than 3 times the five-year average (Western Digital)", () => {
    // Four thin years, then a year of profit several times larger.
    const ys = good().map((y, i, a) => (i < a.length - 1 ? { ...y, netIncome: y.netIncome! * 0.3, operatingIncome: y.netIncome! * 0.4 } : { ...y, netIncome: y.netIncome! * 4, revenue: y.netIncome! * 5.5, operatingIncome: y.netIncome! * 3.5 }));
    const r = longTermChecks(ys)!;
    expect(r.metrics.roeLast! / r.metrics.roe5y!).toBeGreaterThan(3);
    expect(r.metrics.oneOff).toHaveLength(1);
    expect(r.metrics.oneOff[0]).toMatch(/^last year's return on equity is [\d.]+ times the five-year average$/);
    // The company is not removed by the tag.
    expect(by(r)).toMatchObject({ roe_last: true, margin: true });
  });
});

describe("long-term debt from the filing's lines", () => {
  const at = (val: number) => ({ end: "2025-12-31", val, form: "10-K", filed: "2026-02-10" });
  const f = (o: Record<string, number>) => ({ "us-gaap": Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { units: { USD: [at(v)] } }])) });
  const read = (o: Record<string, number>) => debtAt(f(o), "2025-12-31");
  it("takes the noncurrent total, not a total that includes what is due within a year (Procter & Gamble)", () => {
    expect(read({ LongTermDebtNoncurrent: 25_000, LongTermDebt: 34_000, DebtLongtermAndShorttermCombinedAmount: 36_000 })).toEqual({ debt: 25_000, from: "LongTermDebtNoncurrent", kind: "noncurrent total" });
  });
  it("takes the largest noncurrent total (Marriott read as no debt from an empty notes line)", () => {
    expect(read({ LongTermNotesPayable: 0, LongTermDebtAndCapitalLeaseObligations: 13_000 })).toMatchObject({ debt: 13_000, from: "LongTermDebtAndCapitalLeaseObligations" });
  });
  it("adds up noncurrent debt reported in parts (TSMC: bonds and bank loans)", () => {
    const tsm = { "ifrs-full": { NoncurrentPortionOfNoncurrentBondsIssued: { units: { TWD: [at(900)] } }, NoncurrentPortionOfNoncurrentLoansReceived: { units: { TWD: [at(40)] } } } };
    expect(debtAt(tsm, "2025-12-31")).toEqual({ debt: 940, from: "NoncurrentPortionOfNoncurrentBondsIssued + NoncurrentPortionOfNoncurrentLoansReceived", kind: "noncurrent parts" });
  });
  it("uses a total with current maturities when that is all there is, less the current part where reported", () => {
    // A financial company: one long-term debt line, no current split.
    expect(read({ LongTermDebt: 3_400 })).toEqual({ debt: 3_400, from: "LongTermDebt", kind: "total less current part" });
    expect(read({ LongTermDebt: 3_400, LongTermDebtCurrent: 400 })).toMatchObject({ debt: 3_000 });
    // Senior notes or notes payable stand as they are (Evercore, Kinsale).
    expect(read({ NotesPayable: 370 })).toMatchObject({ debt: 370, from: "NotesPayable" });
    expect(read({ SeniorNotes: 500, LongTermDebtCurrent: 100 })).toMatchObject({ debt: 500, from: "SeniorNotes" });
  });
  it("does not take an empty credit line as no debt while another line has a figure", () => {
    expect(read({ LongTermLineOfCredit: 0, SeniorNotes: 5_000 })).toMatchObject({ debt: 5_000, from: "SeniorNotes" });
    expect(read({ LongTermDebtNoncurrent: 0, NotesPayable: 800 })).toMatchObject({ debt: 800 });
  });
  it("is zero only when a debt line says zero, and not found when there is no debt line", () => {
    expect(read({ LongTermDebtNoncurrent: 0 })).toEqual({ debt: 0, from: "LongTermDebtNoncurrent", kind: "noncurrent total" });
    expect(read({ Liabilities: 9_000, LiabilitiesCurrent: 4_000 })).toEqual({ debt: null, from: null, kind: null });
  });
});

describe("the 10-year listing rule", () => {
  it("keeps a company with ten years of annual reports", () => {
    expect(yearsBack("2026-11-28")).toBe("2016-11-28");
    expect(listingAge("2011-02-18", null, "2026-11-28")).toEqual({ young: false, listed: "annual reports on file since 2011-02" });
    expect(listingAge("2016-11-28", null, "2026-11-28").young).toBe(false);
  });
  it("keeps an old listing with a young first report when it was trading ten years ago (Medpace, TSMC, Ferrari)", () => {
    // Medpace: listed August 2016, first annual report early 2017. Foreign companies: in the SEC's data from 2018.
    expect(listingAge("2017-02-28", true, "2026-11-28")).toEqual({ young: false, listed: "trading in 2016-11, ten years before it was screened (first annual report on file 2017-02)" });
    expect(listingAge("2018-04-19", true, "2026-11-28").young).toBe(false);
  });
  it("removes a company that was not trading ten years ago (Airbnb, PDD)", () => {
    expect(listingAge("2021-02-26", false, "2026-11-28")).toEqual({ young: true, listed: "first annual report filed 2021-02-26, and not trading in 2016-11" });
    expect(listingAge("2019-04-24", false, "2026-11-28").young).toBe(true);
    expect(listingAge(null, false, "2026-11-28").young).toBe(true);
  });
  it("reads the annual form, the first annual filing and the cover share count from the facts", () => {
    const row = (y: number, form: string, filed: string) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val: 1, form, filed });
    const facts = {
      "us-gaap": { NetIncomeLoss: { units: { USD: [row(2019, "S-1", "2020-11-16"), row(2020, "10-K", "2021-02-26"), row(2025, "10-K", "2026-02-12"), row(2025, "10-Q", "2026-05-01")] } } },
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: "2026-01-31", val: 600, form: "10-K", filed: "2026-02-12" }, { end: "2026-10-20", val: 610, form: "10-Q", filed: "2026-10-28" }] } } },
    };
    expect(filingFacts(facts)).toEqual({ annualForm: "10-K", firstAnnualFiled: "2021-02-26", sharesOut: 610, sharesOutAt: "2026-10-20" });
    expect(filingFacts({ "ifrs-full": { ProfitLoss: { units: { TWD: [row(2025, "20-F", "2026-04-16")] } } } })).toEqual({ annualForm: "20-F", firstAnnualFiled: "2026-04-16", sharesOut: null, sharesOutAt: null });
  });
});

describe("market value and the price against earnings", () => {
  it("is the price times the cover share count, else the year's average diluted count", () => {
    expect(marketValueOf(50, { annualForm: "10-K", sharesOut: 1_000_000, sharesOutAt: "2026-10-20" }, 990_000)).toEqual({ marketValue: 50_000_000, marketValueFrom: "price × 1,000,000 shares on the report cover of 2026-10-20" });
    expect(marketValueOf(50, { annualForm: "10-K", sharesOut: null, sharesOutAt: null }, 990_000)).toMatchObject({ marketValue: 49_500_000 });
    expect(marketValueOf(50, { annualForm: "40-F", sharesOut: 10, sharesOutAt: "2026-01-31" }, null).marketValue).toBe(500);
  });
  it("is not computed for a foreign annual-report filer, or without a price or a share count, and says why", () => {
    expect(marketValueOf(300, { annualForm: "20-F", sharesOut: 25_000, sharesOutAt: "2025-12-31" }, 25_000)).toEqual({ marketValue: null, marketValueFrom: "files a foreign annual report (20-F): its share count is not in US-listed shares" });
    expect(marketValueOf(null, { annualForm: "10-K", sharesOut: 10, sharesOutAt: "2026-01-31" }, 10).marketValue).toBeNull();
    expect(marketValueOf(50, { annualForm: "10-K", sharesOut: null, sharesOutAt: null }, null).marketValueFrom).toMatch(/^no share count/);
  });
  it("gives price over last fiscal year's earnings, or the reason there is none (ASML, PDD)", () => {
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "USD", annualForm: "10-K" }, 200)).toEqual({ pe: 20, why: null });
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "EUR", annualForm: "20-F" }, 200)).toEqual({ pe: null, why: "reports in EUR" });
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "USD", annualForm: "20-F" }, 200).why).toMatch(/^foreign filer/);
    expect(priceOf({ netIncome: -5, shares: 100, currency: "USD", annualForm: "10-K" }, 200).why).toBe("a loss last year");
    expect(priceOf({ netIncome: 1000, shares: 100, currency: "USD", annualForm: "10-K" }, 5000).pe).toBeNull(); // 500 times: a split since the year end
    expect(priceOf({ netIncome: 1000, shares: null, currency: "USD", annualForm: "10-K" }, 200).pe).toBeNull();
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
  it("removes the names the owner asked about: Texas Pacific Land (6792), EOG and Canadian Natural (1311), CF Industries (2870)", () => {
    expect(["6792", "1311", "2870"].map((c) => removedSector(c))).toEqual(["energy", "energy", "basic materials"]);
  });
  it("keeps Fastenal (5200, retail building materials) and Cintas (2320), and other look-alikes", () => {
    // Software, chips, drugs, soap and cosmetics, waste haulers, homebuilders, banks, fibre and cable, packaging.
    for (const c of ["5200", "2320", "7372", "3674", "2834", "2840", "2844", "4953", "1531", "6021", "3357", "2650", "3559", "", null, "abc"]) expect(removedSector(c)).toBeNull();
  });
  it("has one table for the code and for the page, with no overlapping ranges", () => {
    const sorted = SECTOR_CODES.slice().sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].from).toBeGreaterThan(sorted[i - 1].to);
    for (const c of SECTOR_CODES) expect(removedSector(String(c.from))).toBe(c.sector);
  });
});

const row = (symbol: string, rank: number, roe5y: number, o: { price?: number | null; exchanges?: Array<string | null>; fail?: boolean; removed?: LongTermRow["removed"]; young?: boolean; marketValue?: number | null; annualForm?: string } = {}): LongTermRow => {
  const r = longTermChecks(good())!;
  const checks = o.fail ? r.checks.map((c) => (c.id === "margin" ? { ...c, pass: false } : c)) : r.checks;
  return { symbol, name: symbol, rank, computedAt: "2026-11-28T00:00:00Z", metrics: { ...r.metrics, roe5y, price: o.price === undefined ? 100 : o.price, exchanges: o.exchanges ?? ["Nasdaq"], young: o.young ?? false, listed: "annual reports on file since 2011-02", marketValue: o.marketValue ?? null, marketValueFrom: "test", annualForm: o.annualForm ?? "10-K", sic: "7372", industry: "software" }, checks, removed: o.removed ?? null, error: null };
};

describe("the pool and the final list", () => {
  it("is the largest listed companies, minus cheap shares, removed sectors and young listings, ranked by five-year return on equity", () => {
    const rows = [
      row("AAA", 1, 30), row("BBB", 2, 45), row("PENNY", 3, 60, { price: 4.99 }), row("OIL", 4, 70, { removed: "energy" }), row("THIN", 5, 80, { fail: true }),
      row("OTCQX", 6, 90, { exchanges: ["OTC"] }), row("NOPX", 7, 25, { price: null }), row("NEW", 8, 95, { young: true }),
      { symbol: "FUND", name: "Fund", rank: 9, computedAt: "2026-11-28T00:00:00Z", metrics: null, checks: [], removed: null, error: "no annual reports" } as LongTermRow,
    ];
    const s = screen(rows);
    expect(s.pool.map((r) => r.symbol)).toEqual(["AAA", "BBB", "PENNY", "OIL", "THIN", "NOPX", "NEW"]);
    expect(s.underPrice.map((r) => r.symbol)).toEqual(["PENNY"]);
    expect(s.removedSector.map((r) => r.symbol)).toEqual(["OIL"]);
    expect(s.young.map((r) => r.symbol)).toEqual(["NEW"]);
    expect(s.checked).toBe(4);
    expect(s.failed.margin).toBe(1);
    expect(s.passers.map((r) => r.symbol)).toEqual(["BBB", "AAA", "NOPX"]);
    expect(standing("BBB", rows, s)).toBe("in the pool, passes all five, rank 1");
    expect(standing("NEW", rows, s)).toMatch(/^removed: listed under 10 years/);
    expect(standing("OIL", rows, s)).toMatch(/^removed: energy \(industry code 7372/);
    expect(standing("THIN", rows, s)).toBe("in the pool, fails 1 of five");
    expect(standing("FUND", rows, s)).toMatch(/^not a company for the pool/);
    expect(standing("ZZZ", rows, s)).toBe("not among the entries read from the SEC's list");
    expect(reportLine("BBB", rows, s)).toMatch(/^long term report BBB: in the pool, passes all five, rank 1 \| list #2 \| roe last [\d.]+% pass \| roe 5y 45% pass \| margin 20% pass \| debt pass: long-term debt is 15% of equity/);
  });
  it("keeps the top 25, takes the 1,000 largest only, and reports where the pool is cut", () => {
    const many = Array.from({ length: 1010 }, (_, i) => row(`S${i}`, i + 1, 20 + (i % 97), { marketValue: i === 1004 ? 9e9 : (2000 - i) * 1e7, annualForm: i === 990 ? "20-F" : "10-K" }));
    const s = screen(many);
    expect(s.pool).toHaveLength(1000);
    expect(s.top).toHaveLength(25);
    expect(s.top[0].metrics!.roe5y).toBe(116);
    expect(standing("S1005", many, s)).toMatch(/^not in the pool: company number 1006 by the SEC's size order/);
    expect(s.cutoff.last).toMatchObject({ symbol: "S999", marketValue: 1001e7 });
    expect(s.cutoff).toMatchObject({ computed: 25, low: 1001e7, high: 1025e7, mid: 1013e7, foreignFilers: 1, insideBelowHalf: 0 });
    // One company outside the pool is larger than the middle of its last 25.
    expect(s.cutoff.outsideAbove).toEqual([{ symbol: "S1004", rank: 1005, marketValue: 9e9 }].filter((x) => x.marketValue > 1013e7));
  });
  it("names what a re-run would change in the kept list", () => {
    const c = listChanges([row("AAA", 1, 30), row("OLD", 3, 28)], [row("AAA", 1, 30), row("NEW", 2, 40)]);
    expect(c.join.map((r) => r.symbol)).toEqual(["NEW"]);
    expect(c.leave.map((p) => p.symbol)).toEqual(["OLD"]);
  });
  it("knows a whole read from a partial one", () => {
    const universe = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }];
    expect(readState(universe, [{ symbol: "A" }, { symbol: "C" }])).toEqual({ total: 3, read: 2, complete: false });
    expect(readState(universe, [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }, { symbol: "GONE" }])).toEqual({ total: 3, read: 3, complete: true });
    expect(readState([], []).complete).toBe(false);
  });
  it("sets the list again on the first trading day of January", () => {
    expect(firstTradingDayOfJanuary(2027)).toBe("2027-01-04"); // January 1 is a Friday
    expect(firstTradingDayOfJanuary(2028)).toBe("2028-01-03"); // a Saturday
    expect(firstTradingDayOfJanuary(2029)).toBe("2029-01-02"); // a Monday
    expect(firstTradingDayOfJanuary(2023)).toBe("2023-01-03"); // a Sunday: the Monday is the holiday
  });
  it("always reads a company the SEC's list does not carry near the top, and counts it inside the pool (TSMC)", () => {
    const top = [{ symbol: "AAPL", cik: "320193", name: "Apple Inc.", rank: 1 }, { symbol: "MSFT", cik: "789019", name: "MICROSOFT CORP", rank: 2 }];
    expect(withAlsoRead(top).map((c) => [c.symbol, c.rank])).toEqual([["TSM", 0], ["AAPL", 1], ["MSFT", 2]]);
    const has = [...top, { symbol: "TSM", cik: "1046179", name: "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD", rank: 3 }];
    expect(withAlsoRead(has)).toEqual(has);
    expect(screen([row("TSM", 0, 31), row("AAA", 1, 30)]).pool.map((r) => r.symbol)).toEqual(["TSM", "AAA"]);
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

describe("fiscal years from the SEC's facts", () => {
  const ann = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
  const at = (y: number, val: number) => ({ end: `${y}-12-31`, val, form: "10-K", filed: `${y + 1}-02-10` });
  const ys = [2020, 2021, 2022, 2023, 2024, 2025];
  it("lines up each year's income, balance sheet and operating income by the year end, and the checks follow", () => {
    const facts = { "us-gaap": {
      NetIncomeLoss: { units: { USD: ys.map((y, i) => ann(y, 100 + i * 10)) } },
      Revenues: { units: { USD: ys.map((y, i) => ann(y, 500 + i * 20)) } },
      OperatingIncomeLoss: { units: { USD: ys.map((y, i) => ann(y, 130 + i * 12)) } },
      StockholdersEquity: { units: { USD: ys.map((y, i) => at(y, 400 + i * 20)) } },
      LongTermDebtNoncurrent: { units: { USD: ys.map((y) => at(y, 200)) } },
      Liabilities: { units: { USD: ys.map((y) => at(y, 700)) } }, LiabilitiesCurrent: { units: { USD: ys.map((y) => at(y, 300)) } },
      WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: ys.map((y) => ann(y, 50)) } },
    } };
    const out = fiscalYears(facts);
    expect(out).toHaveLength(6);
    expect(out[5]).toEqual({ end: "2025-12-31", netIncome: 150, revenue: 600, equity: 500, debt: 200, debtFrom: "LongTermDebtNoncurrent", debtKind: "noncurrent total", noncurrentLiabilities: 400, operatingIncome: 190, shares: 50 });
    const r = longTermChecks(out)!;
    expect(by(r)).toEqual({ roe_last: true, roe_5y: true, margin: true, debt: true, growth: true });
    expect(r.metrics).toMatchObject({ netIncome5yAgo: 100, operatingIncome: 190, debtToEquity: 0.4 });
  });
  it("reads a foreign company in its own currency, not in the dollar figure it prints beside it (TSMC)", () => {
    const f20 = (y: number, val: number) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: "20-F", filed: `${y + 1}-04-15` });
    const i20 = (y: number, val: number) => ({ end: `${y}-12-31`, val, form: "20-F", filed: `${y + 1}-04-15` });
    const facts = { "ifrs-full": {
      ProfitLossAttributableToOwnersOfParent: { units: { USD: [2024, 2025].map((y) => f20(y, 40)), TWD: ys.map((y, i) => f20(y, 1000 + i * 100)) } },
      Revenue: { units: { USD: [2025].map((y) => f20(y, 100)), TWD: ys.map((y, i) => f20(y, 2500 + i * 200)) } },
      ProfitLossFromOperatingActivities: { units: { TWD: ys.map((y, i) => f20(y, 1100 + i * 110)) } },
      EquityAttributableToOwnersOfParent: { units: { USD: [2025].map((y) => i20(y, 150)), TWD: ys.map((y, i) => i20(y, 3000 + i * 300)) } },
      LongtermBorrowings: { units: { TWD: ys.map((y) => i20(y, 600)) } },
    } };
    expect(reportingCurrency(facts)).toBe("TWD");
    const out = fiscalYears(facts);
    expect(out.at(-1)).toMatchObject({ end: "2025-12-31", netIncome: 1500, revenue: 3500, equity: 4500, debt: 600, debtFrom: "LongtermBorrowings", operatingIncome: 1650 });
    const r = longTermChecks(out, reportingCurrency(facts))!;
    expect(by(r)).toEqual({ roe_last: true, roe_5y: true, margin: true, debt: true, growth: true });
    expect(r.metrics.currency).toBe("TWD");
    expect(reportingCurrency({ "ifrs-full": { ProfitLoss: { units: { USD: ys.map((y) => f20(y, 1)), JPY: ys.map((y) => f20(y, 150)) } } } })).toBe("JPY");
    expect(reportingCurrency({ "us-gaap": { NetIncomeLoss: { units: { USD: ys.map((y) => ann(y, 1)) } } } })).toBe("USD");
  });
  it("a fiscal year comes from an annual report, not from the rolling twelve months a quarterly report prints (Amazon)", () => {
    const ttm = (start: string, end: string, val: number) => ({ start, end, val, form: "10-Q", filed: end });
    const rows = [ann(2021, 33), ann(2022, -3), ann(2023, 30), ann(2024, 59), ttm("2024-04-01", "2025-03-31", 65), ttm("2024-07-01", "2025-06-30", 70)];
    expect(periodFacts(rows, "annual", 10).map((r) => r.end)).toEqual(["2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31"]);
  });
});
