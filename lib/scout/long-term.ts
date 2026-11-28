/**
 * Long term: a fixed quality screen, run on the companies' own annual reports, following the rules the owner
 * backtested so the two lists can be compared.
 *
 * Pool: the 1,000 largest US-listed companies by market value (foreign companies listed in the US included), share
 * price $5 or more, one share class per company. Removed before the checks: energy, utilities, real estate, basic
 * materials, and companies listed for less than 10 years. Five checks, all required: return on equity 20% or more in
 * the last fiscal year, 20% or more on the five-year average, net profit margin 15% or more, long-term debt no more
 * than half of shareholders' equity (financials included), and net income higher than five fiscal years earlier. A
 * check with a missing input fails. What passes is ranked by five-year average return on equity; the top 25 are kept
 * at equal weight. The kept list is a stored snapshot: set once after a whole read, then left until the first
 * trading day of January.
 *
 * Where the figures come from: the SEC's size-ordered list of listed companies, each company's annual-report data
 * (XBRL), its industry code and exchange from the SEC's company record, and prices from the market feed. No AI,
 * nothing traded.
 */
import { SECTORS } from "@/config/scout";
import type { MarketData } from "../alpaca";
import { query as q } from "../db";
import { getJson } from "../http";
import { periodFacts, pickFacts, pickRevenue, type Fact } from "../sources/fmp";
import { toEt } from "../time";
import * as store from "./store";

export const LONG_TERM = {
  /** The pool: the largest listed companies with annual reports at the SEC, one share class each. */
  pool: 1000,
  /** Entries of the SEC's list read to fill the pool (funds and foreign names that only trade over the counter have no reports and do not count). */
  scan: 1800,
  minPrice: 5,
  roe: 20, margin: 15, debtToEquity: 0.5, years: 5, keep: 25,
  /** Listed for at least this many years on the day the company is screened. */
  minListedYears: 10,
  /** The "one-off gain?" tag: net income above this many times operating income, or last year's return on equity above this many times the five-year average. */
  oneOff: { netOverOperating: 1.5, roeOverAverage: 3 },
  /** Fiscal years read per company (five for the average, one more for its opening equity and for "five years earlier"). */
  yearsRead: 8,
  perRun: 700, refreshDays: 30, runSeconds: 200,
  /** Raise when the rules change: every company is then screened again and the kept list is set again. */
  rev: 8,
  /** The kept list is set only while this is on (off while a new set of rules has its first whole read checked by hand). */
  setList: false,
  /** Until this time the read also runs in the scheduler's quiet hours, so a whole read ordered in the evening finishes the same night. */
  nightReadUntil: "2026-11-28T11:00:00Z",
  /**
   * Companies read whether or not the SEC's list carries them near the top. The list, as read on November 27, 2026,
   * had no entry for TSMC in its first 1,800, though it is among the ten largest companies listed in the US. Such
   * a company has no place on the list, so it is counted inside the pool.
   */
  alsoRead: [{ symbol: "TSM", cik: "1046179", name: "Taiwan Semiconductor Manufacturing Co Ltd" }],
  /** Large foreign listings whose place on the SEC's whole list is logged when the list is read, to see whether any other is missing. */
  listCheck: ["TSM", "NVS", "TM", "SONY", "UL", "TTE", "BHP", "RIO", "MUFG", "HDB", "IBN", "INFY", "ARM", "SE", "MELI", "SPOT", "NU", "SHOP", "ACN", "LIN", "CB", "MDT", "ETN", "BUD", "SNY", "GSK", "BP", "DEO", "RELX", "TD"],
  /** Written to the log, a line each, once a whole read is on file: the owner's backtest list and the names his notes ask about. Raise `reportRev` to write them again. */
  report: ["FTNT", "IDXX", "IBKR", "NVDA", "UI", "MANH", "MEDP", "LRCX", "ASML", "QCOM", "AMAT", "RACE", "CTAS", "ABNB", "MSFT", "DECK", "QLYS", "FAST", "MLI", "TSM", "GOOGL", "ANET", "MPWR", "PG", "ODFL", "AMP", "EVR", "KNSL", "WDC", "PDD", "TPL", "EOG", "CNQ", "CF", "CHKP", "PAYC", "CDNS", "META", "AAPL", "BRK.B"],
  reportRev: 1,
};

type Facts = Record<string, Record<string, { units?: Record<string, Fact[]> }>>;
/** How the long-term debt figure was found: a noncurrent total, noncurrent parts added up, or a total that includes current maturities (less the current part where reported). */
export type DebtKind = "noncurrent total" | "noncurrent parts" | "total less current part";
export interface FiscalYear {
  end: string; netIncome: number | null; revenue: number | null; equity: number | null;
  /** Long-term debt (null: no debt line found in the filing), which filing line it is from, and how it was read. */
  debt: number | null; debtFrom?: string | null; debtKind?: DebtKind | null;
  /** Everything owed that is not due within a year: long-term debt cannot be larger. Null when the filing has no such split (banks, insurers, brokers). */
  noncurrentLiabilities?: number | null;
  operatingIncome?: number | null; shares: number | null;
}

const NET_INCOME = ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"];
const EQUITY = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "EquityAttributableToOwnersOfParent", "Equity"];
const OPERATING_INCOME = ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"];
const SHARES = ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic", "WeightedAverageShares"];
/** Long-term debt after current maturities, as one total. */
const DEBT_NONCURRENT_TOTAL = ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebtAndLeaseObligation", "LongtermBorrowings"];
/** Noncurrent debt reported in parts (added up; the two convertible names are one line). */
const DEBT_NONCURRENT_PARTS: string[][] = [
  ["LongTermNotesPayable"], ["ConvertibleNotesPayableNoncurrent", "ConvertibleDebtNoncurrent"], ["SeniorLongTermNotes"], ["UnsecuredLongTermDebt"], ["SecuredLongTermDebt"], ["LongTermLineOfCredit"], ["OtherLongTermDebtNoncurrent"],
  ["SubordinatedLongTermDebt"], ["NoncurrentPortionOfNoncurrentBondsIssued"], ["NoncurrentPortionOfNoncurrentLoansReceived"], ["NoncurrentPortionOfNoncurrentNotesAndDebenturesIssued"],
  ["NoncurrentPortionOfNoncurrentSecuredBankLoansReceived"], ["NoncurrentPortionOfNoncurrentUnsecuredBankLoansReceived"], ["NoncurrentPortionOfOtherNoncurrentBorrowings"],
];
/** Debt totals that include what falls due within a year (the current part is taken off where the filing reports it). */
const DEBT_WITH_CURRENT = ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "LongTermDebtAndLeaseObligationIncludingCurrentMaturities", "DebtInstrumentCarryingAmount", "DebtAndCapitalLeaseObligations", "DebtLongtermAndShorttermCombinedAmount", "LongTermDebtFairValue", "Borrowings"];
/** Other debt lines a filer may use instead (taken as they stand). */
const DEBT_OTHER = ["SeniorNotes", "NotesPayable", "SecuredDebt", "UnsecuredDebt", "ConvertibleNotesPayable", "ConvertibleDebt", "SubordinatedDebt", "JuniorSubordinatedNotes", "OtherLongTermDebt", "NotesAndLoansPayable", "LoansPayable", "OtherBorrowings", "FederalHomeLoanBankAdvancesLongTerm", "BondsIssued", "LoansReceived", "DebtInstrumentsIssued", "NotesAndDebenturesIssued", "SubordinatedLiabilities", "DebtInstrumentFaceAmount", "LineOfCredit"];
const DEBT_CURRENT_PART = ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "LongTermDebtAndLeaseObligationCurrent", "CurrentPortionOfLongtermBorrowings"];

/** Pure: a balance-sheet figure on (or within ten days of) a date: the latest filing's value. */
function instantAt(facts: Facts, names: string[], end: string): number | null {
  const t = Date.parse(end);
  for (const tax of ["us-gaap", "ifrs-full"]) for (const n of names) for (const [unit, rows] of Object.entries(facts[tax]?.[n]?.units ?? {})) {
    if (unit.includes("/") || !Array.isArray(rows)) continue;
    const near = rows.filter((r) => !r.start && Math.abs(Date.parse(r.end) - t) <= 10 * 86400_000).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""));
    if (near.length) return near[0].val;
  }
  return null;
}


/**
 * Pure: long-term debt on a date, and which filing line it came from. Read in this order:
 *  1. a noncurrent total (long-term debt after current maturities, with or without finance leases): the largest;
 *  2. noncurrent debt reported in parts (notes, convertible notes, credit line, bonds, bank loans): added up;
 *  3. a total that includes current maturities (long-term debt, total debt, senior notes, notes payable): the
 *     largest, less the current part where the filing reports one.
 * A zero in one tier is not taken as "no debt" while another tier has a figure (a filer can report an empty credit
 * line beside its notes). Null when the filing has none of these lines: that is "not found", never "none".
 */
export function debtAt(facts: Facts, end: string): { debt: number | null; from: string | null; kind: DebtKind | null } {
  const at = (n: string) => instantAt(facts, [n], end);
  const best = (names: string[]) => names.map((n) => ({ n, v: at(n) })).filter((x): x is { n: string; v: number } => x.v !== null).sort((a, b) => b.v - a.v)[0] ?? null;
  const total = best(DEBT_NONCURRENT_TOTAL);
  if (total && total.v > 0) return { debt: total.v, from: total.n, kind: "noncurrent total" };
  const parts = DEBT_NONCURRENT_PARTS.map(best).filter((x): x is { n: string; v: number } => !!x);
  const partSum = parts.length ? { n: parts.filter((x) => x.v > 0).map((x) => x.n).join(" + ") || parts[0].n, v: parts.reduce((a, x) => a + x.v, 0) } : null;
  const withCurrent = best(DEBT_WITH_CURRENT), other = best(DEBT_OTHER);
  const currentPart = best(DEBT_CURRENT_PART)?.v ?? 0;
  const gross = withCurrent && (!other || withCurrent.v >= other.v) ? { n: withCurrent.n, v: Math.max(0, withCurrent.v - currentPart) } : other;
  const found = [partSum && { ...partSum, kind: "noncurrent parts" as DebtKind }, gross && { ...gross, kind: "total less current part" as DebtKind }, total && { ...total, kind: "noncurrent total" as DebtKind }].filter((x): x is { n: string; v: number; kind: DebtKind } => !!x);
  if (!found.length) return { debt: null, from: null, kind: null };
  const top = found.sort((a, b) => b.v - a.v)[0];
  return { debt: top.v, from: top.n, kind: top.kind };
}

/** Pure: everything owed beyond a year on a date (noncurrent liabilities), or null when the filing does not split its liabilities that way. */
function noncurrentLiabilitiesAt(facts: Facts, end: string): number | null {
  const direct = instantAt(facts, ["LiabilitiesNoncurrent", "NoncurrentLiabilities"], end);
  if (direct !== null) return direct;
  const all = instantAt(facts, ["Liabilities"], end), current = instantAt(facts, ["LiabilitiesCurrent", "CurrentLiabilities"], end);
  return all !== null && current !== null && all >= current ? all - current : null;
}

/** Pure: a full-year figure for the year ending on a date. */
function yearAt(facts: Facts, names: string[], end: string, unitOk: (u: string) => boolean = (u) => !u.includes("/")): number | null {
  for (const tax of ["us-gaap", "ifrs-full"]) for (const n of names) for (const [unit, rows] of Object.entries(facts[tax]?.[n]?.units ?? {})) {
    if (!unitOk(unit) || !Array.isArray(rows)) continue;
    const hit = periodFacts(rows, "annual", 40).find((r) => r.end === end);
    if (hit) return hit.val;
  }
  return null;
}


/**
 * Pure: the currency the company keeps its accounts in: the one its annual net income is on file in for the most
 * fiscal years. A foreign company often prints a US-dollar "convenience" figure for the latest year beside its own
 * currency; read as its accounts, that would set dollars of profit against Taiwan dollars of equity.
 */
export function reportingCurrency(facts: Facts): string | null {
  const years = new Map<string, Set<string>>();
  for (const tax of ["us-gaap", "ifrs-full"]) for (const n of NET_INCOME) for (const [unit, rows] of Object.entries(facts[tax]?.[n]?.units ?? {})) {
    if (unit.includes("/") || !Array.isArray(rows)) continue;
    const set = years.get(unit) ?? new Set<string>();
    for (const r of periodFacts(rows, "annual", 40)) set.add(r.end);
    years.set(unit, set);
  }
  // Most fiscal years wins; on a tie the home currency does (the convenience figure is always in dollars).
  return [...years].filter(([, set]) => set.size).sort((a, b) => b[1].size - a[1].size || Number(a[0] === "USD") - Number(b[0] === "USD"))[0]?.[0] ?? null;
}

/** Pure: the facts with only one currency's figures (and share counts), so nothing is mixed across currencies. */
function inCurrency(facts: Facts, unit: string): Facts {
  const out: Facts = {};
  for (const [tax, concepts] of Object.entries(facts)) {
    out[tax] = {};
    for (const [name, c] of Object.entries(concepts ?? {})) {
      const units = Object.fromEntries(Object.entries(c?.units ?? {}).filter(([u]) => u === unit || u === "shares"));
      if (Object.keys(units).length) out[tax][name] = { units };
    }
  }
  return out;
}

/** Pure: the company's fiscal years on file (oldest first), from its annual net income, in the one currency it keeps its accounts in. */
export function fiscalYears(all: Facts): FiscalYear[] {
  const unit = reportingCurrency(all);
  const facts = unit ? inCurrency(all, unit) : all;
  const ni = pickFacts(facts, NET_INCOME);
  if (!ni) return [];
  const rev = pickRevenue(facts, "annual");
  const revRows = rev ? periodFacts(rev.rows, "annual", 40) : [];
  return periodFacts(ni.rows, "annual", LONG_TERM.yearsRead).map((y) => {
    const d = debtAt(facts, y.end);
    return {
      end: y.end, netIncome: y.val, revenue: revRows.find((r) => r.end === y.end)?.val ?? null,
      equity: instantAt(facts, EQUITY, y.end), debt: d.debt, debtFrom: d.from, debtKind: d.kind, noncurrentLiabilities: noncurrentLiabilitiesAt(facts, y.end),
      operatingIncome: yearAt(facts, OPERATING_INCOME, y.end), shares: yearAt(facts, SHARES, y.end, (u) => u === "shares"),
    };
  });
}

const ANNUAL_FORM = /^(10-K|20-F|40-F)/i;
/** Pure: what the filings say about the company as a listing: the form its annual report is on, the day its first annual report on file was filed, and the share count on the cover of its latest report. */
export function filingFacts(facts: Facts): { annualForm: string | null; firstAnnualFiled: string | null; sharesOut: number | null; sharesOutAt: string | null } {
  let first: string | null = null, form: string | null = null, formEnd = "";
  for (const tax of ["us-gaap", "ifrs-full"]) for (const n of NET_INCOME) for (const rows of Object.values(facts[tax]?.[n]?.units ?? {})) for (const r of Array.isArray(rows) ? rows : []) {
    if (!r.filed || !ANNUAL_FORM.test(r.form ?? "")) continue;
    if (!first || r.filed < first) first = r.filed;
    if (r.end > formEnd) { formEnd = r.end; form = (r.form ?? "").toUpperCase().replace(/\/A$/, ""); }
  }
  const cover = (facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).filter((r) => r.val > 0).sort((a, b) => a.end.localeCompare(b.end) || (a.filed ?? "").localeCompare(b.filed ?? "")).at(-1) ?? null;
  return { annualForm: form, firstAnnualFiled: first, sharesOut: cover?.val ?? null, sharesOutAt: cover?.end ?? null };
}

export type RemovedSector = "energy" | "utilities" | "real estate" | "basic materials";
export const REMOVED_SECTORS: RemovedSector[] = ["energy", "utilities", "real estate", "basic materials"];

/**
 * The SEC industry codes (SIC) that put a company in a removed sector. One table for the code and for the page.
 * Left in on purpose: drugs (2830s) and soap and cosmetics (2840s) among the chemicals, waste haulers (4950s),
 * homebuilders (1531), paper packaging (2650s), fibre and cable (3357), and retailers of building materials (5200s,
 * where Fastenal files).
 */
export const SECTOR_CODES: Array<{ sector: RemovedSector; from: number; to: number; what: string }> = [
  { sector: "energy", from: 1200, to: 1299, what: "coal mining" },
  { sector: "energy", from: 1300, to: 1399, what: "oil and gas extraction and oilfield services" },
  { sector: "energy", from: 2900, to: 2999, what: "petroleum refining" },
  { sector: "energy", from: 3533, to: 3533, what: "oil and gas field machinery" },
  { sector: "energy", from: 4600, to: 4619, what: "pipelines (not natural gas)" },
  { sector: "energy", from: 4922, to: 4923, what: "natural gas transmission" },
  { sector: "energy", from: 5170, to: 5172, what: "petroleum products wholesale" },
  { sector: "energy", from: 6792, to: 6792, what: "oil royalty traders" },
  { sector: "utilities", from: 4900, to: 4921, what: "electric, gas and sanitary services (general), electric services" },
  { sector: "utilities", from: 4924, to: 4949, what: "natural gas distribution, combined electric and gas, water supply" },
  { sector: "utilities", from: 4960, to: 4991, what: "steam supply, cogeneration" },
  { sector: "real estate", from: 6500, to: 6599, what: "real estate operators, agents, managers and developers" },
  { sector: "real estate", from: 6798, to: 6798, what: "real estate investment trusts" },
  { sector: "basic materials", from: 1000, to: 1099, what: "metal mining (gold, copper, iron and other ores)" },
  { sector: "basic materials", from: 1400, to: 1499, what: "quarrying and nonmetallic minerals" },
  { sector: "basic materials", from: 2400, to: 2449, what: "lumber and wood products" },
  { sector: "basic materials", from: 2600, to: 2631, what: "pulp, paper and paperboard mills" },
  { sector: "basic materials", from: 2800, to: 2829, what: "industrial chemicals, plastics and synthetic materials" },
  { sector: "basic materials", from: 2850, to: 2899, what: "paints, industrial organic chemicals, fertiliser, other chemical products" },
  { sector: "basic materials", from: 3240, to: 3299, what: "cement, concrete, gypsum, stone and mineral products" },
  { sector: "basic materials", from: 3310, to: 3356, what: "steel works and primary and rolled metals" },
  { sector: "basic materials", from: 3360, to: 3399, what: "metal foundries and other primary metal products" },
];

/** Pure: the removed sector an SEC industry code belongs to, or null when the company stays. */
export function removedSector(sic: string | null | undefined): RemovedSector | null {
  const n = Number(sic);
  if (!sic || !Number.isFinite(n) || n <= 0) return null;
  return SECTOR_CODES.find((c) => n >= c.from && n <= c.to)?.sector ?? null;
}

/** Pure: listed on a US exchange, from the SEC record's exchange names. Only "over the counter and nowhere else" is a no; no record is not. */
export function usListed(exchanges: Array<string | null> | null | undefined): boolean {
  const named = (exchanges ?? []).filter((e): e is string => !!e && !!e.trim());
  return !named.length || named.some((e) => !/^otc/i.test(e.trim()));
}

export type CheckId = "roe_last" | "roe_5y" | "margin" | "debt" | "growth";
export const CHECK_ORDER: CheckId[] = ["roe_last", "roe_5y", "margin", "debt", "growth"];
/** A check passes or fails. A check with an input that cannot be found fails, and `detail` says which. */
export interface Check { id: CheckId; pass: boolean; detail: string }
export const CHECK_LABEL: Record<CheckId, string> = {
  roe_last: "Return on equity, last year", roe_5y: "Return on equity, five-year average", margin: "Net profit margin", debt: "Long-term debt against equity", growth: "Net income against five years earlier",
};
export const CHECK_ABOUT: Record<CheckId, string> = {
  roe_last: `Net income of the last fiscal year as a share of shareholders' equity (the average of the year's opening and closing equity): ${LONG_TERM.roe}% or more.`,
  roe_5y: `The same figure for each of the last ${LONG_TERM.years} fiscal years, averaged: ${LONG_TERM.roe}% or more.`,
  margin: `Net income of the last fiscal year as a share of its sales: ${LONG_TERM.margin}% or more. For a bank, sales are interest income plus other income.`,
  debt: `Long-term debt (after current maturities) at the last fiscal year end is no more than ${Math.round(LONG_TERM.debtToEquity * 100)}% of shareholders' equity. Asked of every company, financials included. The filing's debt lines are read in order: a noncurrent total, noncurrent parts added up, then a total including current maturities less the current part. "None" is shown only when the filing reports a debt line of zero. With no debt line at all, the company passes only if everything it owes beyond a year (all noncurrent liabilities, which include any long-term debt) is within the limit; otherwise it fails.`,
  growth: "Net income of the last fiscal year is higher than in the fiscal year five years before it.",
};

export interface Metrics {
  years: number; lastYear: string;
  roeLast: number | null; roe5y: number | null; margin: number | null;
  /** Long-term debt over equity (null: not found, or equity at or below zero), the debt itself, the filing line it is from and how it was read. */
  debtToEquity: number | null; debt: number | null; debtFrom: string | null; debtKind: DebtKind | null;
  /** With no debt line: all noncurrent liabilities over equity, the most long-term debt could be (null: the filing has no such split). */
  debtCeiling: number | null;
  equity: number | null; netIncome: number; netIncome5yAgo: number | null; year5yAgo: string | null;
  revenue: number | null; operatingIncome: number | null;
  /** Why the "one-off gain?" tag is on (empty: it is not). */
  oneOff: string[];
  /** The year's average diluted share count (for the price against earnings). */
  shares: number | null;
  /** The currency the company reports in (a price in dollars cannot be set against profit in another currency). */
  currency?: string | null;
  /** From the filings: the annual report's form, the day the first annual report on file was filed, the share count on the latest cover. */
  annualForm?: string | null; firstAnnualFiled?: string | null; sharesOut?: number | null; sharesOutAt?: string | null;
  /** From the SEC's company record: industry code and name, and where it is listed. */
  sic?: string | null; industry?: string | null; exchanges?: Array<string | null> | null;
  /** The share price when the company was screened (null: the market feed had none). */
  price?: number | null;
  /** Market value in dollars: that price times the share count named in `marketValueFrom` (null with the reason there). */
  marketValue?: number | null; marketValueFrom?: string | null;
  /** Listed for under ten years on the day it was screened, and the evidence either way. */
  young?: boolean; listed?: string | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const YEAR_MS = 365.25 * 86400_000;
const yearOf = (end: string) => end.slice(0, 4);

/** Pure: the five checks for one company, from its fiscal years (oldest first). Null with no fiscal year of net income on file. */
export function longTermChecks(years: FiscalYear[], currency: string | null = "USD"): { metrics: Metrics; checks: Check[] } | null {
  const ys = years.filter((y) => y.netIncome !== null);
  if (!ys.length) return null;
  const last = ys[ys.length - 1], n = ys.length;
  const checks: Check[] = [];

  // The five fiscal years of the average (they have to be five in a row), and the year-end equity before them.
  const five = ys.slice(-LONG_TERM.years);
  const inARow = five.length === LONG_TERM.years && Math.abs((Date.parse(last.end) - Date.parse(five[0].end)) / YEAR_MS - (LONG_TERM.years - 1)) < 0.2;
  // Equity at or below zero in the latest year, or in any year of the average, fails the two return checks and the debt check.
  const noEquity = (inARow ? five : [last]).filter((y) => y.equity !== null && y.equity <= 0);
  const equityFail = last.equity !== null && last.equity <= 0 ? `shareholders' equity is at or below zero in ${yearOf(last.end)}` : noEquity.length ? `shareholders' equity was at or below zero in ${noEquity.map((y) => yearOf(y.end)).join(", ")}` : null;

  // Return on equity for a year: net income over the average of the year's opening and closing equity.
  const roeOf = (i: number): { roe: number } | { missing: string } => {
    const close = ys[i].equity, open = i > 0 ? ys[i - 1].equity : null;
    if (close === null) return { missing: `shareholders' equity is not in the ${yearOf(ys[i].end)} report` };
    if (open === null) return { missing: `no year-end equity before ${yearOf(ys[i].end)} on file (the year's opening equity)` };
    if (close <= 0 || open <= 0) return { missing: `shareholders' equity was at or below zero ${close <= 0 ? `in ${yearOf(ys[i].end)}` : `at the start of ${yearOf(ys[i].end)}`}` };
    return { roe: (ys[i].netIncome! / ((close + open) / 2)) * 100 };
  };
  const lastRoe = roeOf(n - 1);
  const roeLast = "roe" in lastRoe ? r1(lastRoe.roe) : null;
  checks.push({ id: "roe_last", pass: !equityFail && roeLast !== null && roeLast >= LONG_TERM.roe, detail: equityFail ?? (roeLast !== null ? `${roeLast}% in ${yearOf(last.end)}` : (lastRoe as { missing: string }).missing) });

  const roes = inARow ? five.map((_, k) => roeOf(n - five.length + k)) : [];
  const missing5 = roes.find((x): x is { missing: string } => "missing" in x);
  const roe5y = inARow && !missing5 ? r1(roes.reduce((a, x) => a + (x as { roe: number }).roe, 0) / roes.length) : null;
  checks.push({ id: "roe_5y", pass: !equityFail && roe5y !== null && roe5y >= LONG_TERM.roe, detail: equityFail ?? (roe5y !== null ? `${roe5y}% on average, ${yearOf(five[0].end)} to ${yearOf(last.end)}` : !inARow ? `fewer than ${LONG_TERM.years} fiscal years in a row on file` : missing5!.missing) });

  // Net income above the sales line means the sales line found is not the company's sales: the input is missing.
  const rawMargin = last.revenue !== null && last.revenue > 0 ? (last.netIncome! / last.revenue) * 100 : null;
  const margin = rawMargin !== null && rawMargin <= 100 ? r1(rawMargin) : null;
  checks.push({ id: "margin", pass: margin !== null && margin >= LONG_TERM.margin, detail: margin !== null ? `${margin}% of sales in ${yearOf(last.end)}` : rawMargin !== null ? "net income is larger than the sales line on file, so sales could not be read" : "sales are not in the report" });

  // Long-term debt against equity. No debt line: the most it could be is everything owed beyond a year.
  const equityOk = last.equity !== null && last.equity > 0;
  const debtToEquity = equityOk && last.debt !== null ? r2(last.debt / last.equity!) : null;
  const ceiling = equityOk && last.debt === null && typeof last.noncurrentLiabilities === "number" ? r2(last.noncurrentLiabilities / last.equity!) : null;
  const debtPass = !equityFail && equityOk && (last.debt !== null ? last.debt / last.equity! <= LONG_TERM.debtToEquity : ceiling !== null && ceiling <= LONG_TERM.debtToEquity);
  checks.push({
    id: "debt", pass: debtPass,
    detail: equityFail ?? (last.equity === null ? "shareholders' equity is not in the report"
      : last.debt !== null ? (last.debt === 0 ? `the filing reports no long-term debt (${last.debtFrom} is zero)` : `long-term debt is ${Math.round((last.debt / last.equity!) * 100)}% of equity (${last.debtFrom}${last.debtKind === "total less current part" ? ", less the part due within a year where reported" : ""})`)
      : ceiling !== null ? `no long-term debt line in the filing; everything owed beyond a year is ${Math.round(ceiling * 100)}% of equity${ceiling <= LONG_TERM.debtToEquity ? ", so long-term debt is within the limit" : ", so the limit cannot be confirmed"}`
      : "no long-term debt figure found in the filing, and its liabilities are not split by when they fall due"),
  });

  const t5 = Date.parse(last.end) - LONG_TERM.years * YEAR_MS;
  const ago = ys.find((y) => Math.abs(Date.parse(y.end) - t5) <= 45 * 86400_000) ?? null;
  checks.push({ id: "growth", pass: !!ago && last.netIncome! > ago.netIncome!, detail: ago ? `${last.netIncome! > ago.netIncome! ? "higher" : "not higher"} than in ${yearOf(ago.end)}` : `no fiscal year ${LONG_TERM.years} years before ${yearOf(last.end)} on file` });

  // A profit that operations do not explain, or a return far above the company's own average, is tagged for the owner to judge.
  const op = last.operatingIncome ?? null;
  const oneOff: string[] = [];
  if (op !== null && last.netIncome! > 0 && last.netIncome! > LONG_TERM.oneOff.netOverOperating * op) oneOff.push(op > 0 ? `net income is ${r1(last.netIncome! / op)} times operating income` : "net income is positive while operations made a loss");
  if (roeLast !== null && roe5y !== null && roe5y > 0 && roeLast > LONG_TERM.oneOff.roeOverAverage * roe5y) oneOff.push(`last year's return on equity is ${r1(roeLast / roe5y)} times the five-year average`);

  return {
    metrics: {
      years: n, lastYear: last.end, roeLast, roe5y, margin, debtToEquity, debt: last.debt, debtFrom: last.debtFrom ?? null, debtKind: last.debtKind ?? null, debtCeiling: ceiling,
      equity: last.equity, netIncome: last.netIncome!, netIncome5yAgo: ago?.netIncome ?? null, year5yAgo: ago?.end ?? null, revenue: last.revenue, operatingIncome: op, oneOff, shares: last.shares, currency,
    },
    checks,
  };
}

/** Pure: does the company pass all five? */
export const passesAll = (checks: Check[]) => CHECK_ORDER.every((id) => checks.find((c) => c.id === id)?.pass === true);

/** Pure: the day ten years (the listing rule's span) before a day. */
export function yearsBack(day: string, years = LONG_TERM.minListedYears): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y - years, m - 1, d)).toISOString().slice(0, 10);
}

/**
 * Pure: listed for under ten years on a day? Listed long enough when the first annual report on file was filed ten
 * years or more before, or when the stock was trading in the month up to the ten-year mark (the SEC's data starts
 * in 2009, and for foreign companies in 2018, so an old listing can have a young first report). `traded` is whether
 * the market feed has trades in that month (null: not looked up).
 */
export function listingAge(firstAnnualFiled: string | null, traded: boolean | null, day: string): { young: boolean; listed: string } {
  const mark = yearsBack(day);
  if (firstAnnualFiled && firstAnnualFiled <= mark) return { young: false, listed: `annual reports on file since ${firstAnnualFiled.slice(0, 7)}` };
  if (traded) return { young: false, listed: `trading in ${mark.slice(0, 7)}, ten years before it was screened${firstAnnualFiled ? ` (first annual report on file ${firstAnnualFiled.slice(0, 7)})` : ""}` };
  return { young: true, listed: `${firstAnnualFiled ? `first annual report filed ${firstAnnualFiled}` : "no annual report filing date on file"}${traded === false ? `, and not trading in ${mark.slice(0, 7)}` : ", and its trading ten years back could not be looked up"}` };
}

/**
 * Pure: market value in dollars and what it is made of. The price is the latest trade when the company was
 * screened. The share count is the one on the cover of its latest annual or quarterly report; without one, the
 * fiscal year's average diluted count. Not computed for a company that files a foreign annual report (form 20-F):
 * its share count is in home-market shares, and one US-listed share is often several of those or a fraction of one.
 */
export function marketValueOf(price: number | null, f: { annualForm: string | null; sharesOut: number | null; sharesOutAt: string | null }, weighted: number | null): { marketValue: number | null; marketValueFrom: string } {
  if (!price) return { marketValue: null, marketValueFrom: "no price from the market feed" };
  if (/^20-F/i.test(f.annualForm ?? "")) return { marketValue: null, marketValueFrom: "files a foreign annual report (20-F): its share count is not in US-listed shares" };
  if (f.sharesOut) return { marketValue: Math.round(price * f.sharesOut), marketValueFrom: `price × ${f.sharesOut.toLocaleString("en-US")} shares on the report cover of ${f.sharesOutAt}` };
  if (weighted) return { marketValue: Math.round(price * weighted), marketValueFrom: `price × ${Math.round(weighted).toLocaleString("en-US")} average diluted shares of the last fiscal year (no count on the report cover)` };
  return { marketValue: null, marketValueFrom: "no share count in the filings (several share classes reported separately)" };
}

/**
 * Pure: the price against last fiscal year's earnings, for information (it is not part of the screen), or the
 * reason there is none: another reporting currency, a foreign filer's share count, a loss, or figures that do not
 * line up (a ratio under 2 or over 200 is a split since the year end, not a price).
 */
export function priceOf(m: Pick<Metrics, "netIncome" | "shares" | "currency" | "annualForm">, price: number | null): { pe: number | null; why: string | null } {
  if (m.currency && m.currency !== "USD") return { pe: null, why: `reports in ${m.currency}` };
  if (/^20-F/i.test(m.annualForm ?? "")) return { pe: null, why: "foreign filer: its share count is not in US-listed shares" };
  if (!price) return { pe: null, why: "no price" };
  if (m.netIncome <= 0) return { pe: null, why: "a loss last year" };
  if (!m.shares) return { pe: null, why: "no share count in the report" };
  const pe = (price * m.shares) / m.netIncome;
  return pe < 2 || pe > 200 ? { pe: null, why: "price and share count do not line up (a split since the year end?)" } : { pe: r1(pe), why: null };
}

export interface LongTermRow { symbol: string; name: string | null; /** Place on the SEC's size-ordered list (1 is the largest; 0: added by hand). */ rank: number | null; computedAt: string; metrics: Metrics | null; checks: Check[]; removed: RemovedSector | null; error: string | null }

export interface Cutoff {
  /** Company number 1,000 (the last in the pool), with its market value when it could be computed. */
  last: { symbol: string; name: string | null; rank: number | null; marketValue: number | null; marketValueFrom: string | null } | null;
  /** The computed market values among the last 25 of the pool: lowest, middle, highest, and how many could be computed. */
  low: number | null; mid: number | null; high: number | null; computed: number;
  /** Companies outside the pool whose computed market value is above that middle value (largest first), and pool companies under half of it. */
  outsideAbove: Array<{ symbol: string; rank: number | null; marketValue: number }>; insideBelowHalf: number;
  /** Pool companies that file a foreign annual report (their market value is not computed here). */
  foreignFilers: number;
}

export interface Screen {
  /** Companies read so far that count toward the pool, and the pool itself (the largest 1,000 of them). */
  companies: number; pool: LongTermRow[];
  underPrice: LongTermRow[]; removedSector: LongTermRow[]; young: LongTermRow[];
  /** Of the companies left after price, sector and listing age: how many did not pass each check. */
  failed: Record<CheckId, number>; checked: number;
  /** Passing all five, best five-year return on equity first; `top` is the first 25. */
  passers: LongTermRow[]; top: LongTermRow[];
  cutoff: Cutoff;
}

const median = (xs: number[]) => { const a = xs.slice().sort((x, y) => x - y), m = Math.floor(a.length / 2); return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null; };

/** Pure: the whole screen from the rows on file. */
export function screen(rows: LongTermRow[]): Screen {
  const companies = rows.filter((r) => r.metrics && usListed(r.metrics.exchanges)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const pool = companies.slice(0, LONG_TERM.pool);
  const underPrice = pool.filter((r) => typeof r.metrics!.price === "number" && r.metrics!.price < LONG_TERM.minPrice);
  const priced = pool.filter((r) => !underPrice.includes(r));
  const removed = priced.filter((r) => r.removed);
  const young = priced.filter((r) => !r.removed && r.metrics!.young);
  const left = priced.filter((r) => !r.removed && !r.metrics!.young);
  const failed = Object.fromEntries(CHECK_ORDER.map((id) => [id, left.filter((r) => r.checks.find((c) => c.id === id)?.pass !== true).length])) as Record<CheckId, number>;
  const passers = left.filter((r) => passesAll(r.checks)).sort((a, b) => (b.metrics!.roe5y ?? 0) - (a.metrics!.roe5y ?? 0) || (a.rank ?? 0) - (b.rank ?? 0));

  const mv = (r: LongTermRow) => r.metrics!.marketValue ?? null;
  const tail = pool.slice(-25).map(mv).filter((x): x is number => x !== null);
  const mid = median(tail), lastRow = pool.length >= LONG_TERM.pool ? pool[pool.length - 1] : null;
  const cutoff: Cutoff = {
    last: lastRow ? { symbol: lastRow.symbol, name: lastRow.name, rank: lastRow.rank, marketValue: mv(lastRow), marketValueFrom: lastRow.metrics!.marketValueFrom ?? null } : null,
    low: tail.length ? Math.min(...tail) : null, mid, high: tail.length ? Math.max(...tail) : null, computed: tail.length,
    outsideAbove: mid === null ? [] : companies.slice(LONG_TERM.pool).filter((r) => (mv(r) ?? 0) > mid).map((r) => ({ symbol: r.symbol, rank: r.rank, marketValue: mv(r)! })).sort((a, b) => b.marketValue - a.marketValue),
    insideBelowHalf: mid === null ? 0 : pool.filter((r) => mv(r) !== null && mv(r)! < mid / 2).length,
    foreignFilers: pool.filter((r) => /^20-F/i.test(r.metrics!.annualForm ?? "")).length,
  };
  return { companies: companies.length, pool, underPrice, removedSector: removed, young, failed, checked: left.length, passers, top: passers.slice(0, LONG_TERM.keep), cutoff };
}

/** Pure: where one company stands in the screen, in words (for the reconciliation the owner asked for). */
export function standing(symbol: string, rows: LongTermRow[], s: Screen): string {
  const r = rows.find((x) => x.symbol === symbol);
  if (!r) return "not among the entries read from the SEC's list";
  if (!r.metrics) return `not a company for the pool: ${r.error ?? "no annual reports"}`;
  if (!usListed(r.metrics.exchanges)) return "not in the pool: trades over the counter only";
  if (!s.pool.includes(r)) return `not in the pool: company number ${rows.filter((x) => x.metrics && usListed(x.metrics.exchanges) && (x.rank ?? 1e9) < (r.rank ?? 1e9)).length + 1} by the SEC's size order (the pool is the first ${LONG_TERM.pool}); its checks: ${CHECK_ORDER.filter((id) => r.checks.find((c) => c.id === id)?.pass !== true).length} of five failed`;
  if (s.underPrice.includes(r)) return `removed: share price $${r.metrics.price} is under $${LONG_TERM.minPrice}`;
  if (r.removed) return `removed: ${r.removed} (industry code ${r.metrics.sic}, ${r.metrics.industry})`;
  if (r.metrics.young) return `removed: listed under ${LONG_TERM.minListedYears} years (${r.metrics.listed})`;
  const place = s.passers.indexOf(r);
  return place >= 0 ? `in the pool, passes all five, rank ${place + 1}` : `in the pool, fails ${CHECK_ORDER.filter((id) => r.checks.find((c) => c.id === id)?.pass !== true).length} of five`;
}

export interface KeptList {
  year: number; setAt: string;
  /** The 25 as they stood when the list was set: a stored copy, never read again from the screen. */
  picks: LongTermRow[];
  counts: { pool: number; passers: number } | null;
}

/** Pure: what a re-run today would change in the kept list. */
export function listChanges(kept: LongTermRow[], top: LongTermRow[]): { join: LongTermRow[]; leave: LongTermRow[] } {
  const now = new Set(top.map((r) => r.symbol)), had = new Set(kept.map((p) => p.symbol));
  return { join: top.filter((r) => !had.has(r.symbol)), leave: kept.filter((p) => !now.has(p.symbol)) };
}

/** Pure: the first trading day of January: the first weekday after New Year's Day (and after the Monday off when January 1 falls on a Sunday). */
export function firstTradingDayOfJanuary(year: number): string {
  const dow = (d: number) => new Date(Date.UTC(year, 0, d)).getUTCDay();
  let d = dow(1) === 0 ? 3 : 2;
  while (dow(d) === 0 || dow(d) === 6) d++;
  return `${year}-01-${String(d).padStart(2, "0")}`;
}

/** Pure: how far the read is: entries of the list that have a reading under the current rules, and whether that is all of them. */
export function readState(universe: Array<{ symbol: string }>, rows: Array<{ symbol: string }>): { total: number; read: number; complete: boolean } {
  const have = new Set(rows.map((r) => r.symbol));
  const read = universe.filter((c) => have.has(c.symbol)).length;
  return { total: universe.length, read, complete: universe.length > 0 && read === universe.length };
}

const FUNDS = new Set<string>(Object.values(SECTORS));
export interface Listed { symbol: string; cik: string; name: string; rank: number }

/**
 * Pure: the entries to read from the SEC's list (largest first): one entry per company (a second share class such
 * as GOOG beside GOOGL is the same company), plain symbols only, and no sector funds.
 */
export function largestCompanies(list: Array<{ cik: string; ticker: string; title: string }>, size = LONG_TERM.scan): Listed[] {
  const seen = new Set<string>();
  const out: Listed[] = [];
  for (const x of list) {
    if (out.length >= size) break;
    if (seen.has(x.cik) || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(x.ticker) || FUNDS.has(x.ticker)) continue;
    seen.add(x.cik);
    out.push({ symbol: x.ticker, cik: x.cik, name: x.title, rank: out.length + 1 });
  }
  return out;
}

const UNIVERSE_KEY = `longterm:universe:${LONG_TERM.scan}:r${LONG_TERM.rev}`;

/** Pure: the entries to read: the largest on the list, and before them any always-read company the list does not carry among those. */
export function withAlsoRead(top: Listed[], also: Array<{ symbol: string; cik: string; name: string }> = LONG_TERM.alsoRead): Listed[] {
  const missing = also.filter((a) => !top.some((c) => c.cik === a.cik || c.symbol === a.symbol));
  return [...missing.map((a) => ({ ...a, rank: 0 })), ...top];
}

/** Pure: where some large foreign listings sit on the SEC's whole list (its own order, 1 first), or that they are absent. */
export function listPlaces(list: Array<{ cik: string; ticker: string; title: string }>, symbols: string[] = LONG_TERM.listCheck): string {
  return symbols.map((s) => { const i = list.findIndex((x) => x.ticker === s); return i < 0 ? `${s} absent` : `${s} ${i + 1}`; }).join(", ");
}
/** The list being read, kept for a week (the SEC's file is about a megabyte). */
export async function longTermUniverse(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<Listed[]> {
  const hit = await store.cacheGet<Listed[]>(UNIVERSE_KEY).catch(() => null);
  if (hit?.data?.length && Date.now() - Date.parse(hit.updatedAt) < 7 * 86400_000) return hit.data;
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return hit?.data ?? [];
  const { secTickerList } = await import("../sources/edgar");
  const whole = await secTickerList(ua, fetchImpl);
  const list = whole.length ? withAlsoRead(largestCompanies(whole)) : [];
  if (list.length) {
    const tsmc = whole.map((x, i) => ({ x, i })).filter(({ x }) => x.cik === "1046179" || /taiwan semi/i.test(x.title));
    console.log(`long term list: ${whole.length} entries on the SEC's list · places: ${listPlaces(whole)} · TSMC by number or name: ${tsmc.map(({ x, i }) => `${x.ticker} ${i + 1} "${x.title}"`).join(", ") || "no entry"}`);
    await store.cachePut(UNIVERSE_KEY, list).catch(() => undefined);
  }
  return list.length ? list : hit?.data ?? [];
}

/** A listed name as people write it ("APPLE INC" → "Apple Inc"). */
const nice = (t: string) => (t === t.toUpperCase() ? t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t);

const toRow = (r: Record<string, unknown>): LongTermRow => ({
  symbol: String(r.symbol), name: (r.name as string) ?? null, rank: r.rank === null || r.rank === undefined ? null : Number(r.rank), computedAt: new Date(r.computed_at as string).toISOString(),
  metrics: (r.metrics as Metrics) ?? null, checks: (r.checks as Check[]) ?? [], removed: REMOVED_SECTORS.includes(r.sector as RemovedSector) ? (r.sector as RemovedSector) : null, error: (r.error as string) ?? null,
});

/** Every entry read under the current rules. */
export async function longTermRows(): Promise<LongTermRow[]> {
  return (await q(`SELECT * FROM long_term WHERE rev = $1 ORDER BY rank`, [LONG_TERM.rev])).map(toRow);
}

/** The kept lists under the current rules, newest first. Each is the stored copy from the day it was set. */
export async function keptLists(): Promise<KeptList[]> {
  return (await q(`SELECT year, set_at, picks, counts FROM long_term_lists WHERE rev = $1 ORDER BY year DESC`, [LONG_TERM.rev])).map((r) => ({ year: Number(r.year), setAt: new Date(r.set_at as string).toISOString(), picks: (r.picks as LongTermRow[]) ?? [], counts: (r.counts as KeptList["counts"]) ?? null }));
}

/** A batch call to the market feed and, when it fails, each symbol on its own (one symbol the feed refuses must not lose the batch). Null when nothing answers at all. */
async function batchOrEach<T>(symbols: string[], call: (s: string[]) => Promise<T>, merge: (a: T, b: T) => T, empty: T): Promise<T | null> {
  if (!symbols.length) return empty;
  try { return await call(symbols); } catch { /* each on its own below */ }
  let out = empty, ok = 0;
  for (const sym of symbols) { try { out = merge(out, await call([sym])); ok++; } catch { /* this symbol only */ } }
  return ok ? out : null;
}

const usd = (x: number | null | undefined) => (x === null || x === undefined ? "?" : x >= 1e12 ? `$${(x / 1e12).toFixed(2)}T` : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : `$${Math.round(x / 1e6)}M`);
const mark = (c: Check | undefined) => (c?.pass ? "pass" : "FAIL");

/** One company's reading in a line, for the log (the reconciliation is read from these). */
export function reportLine(symbol: string, rows: LongTermRow[], s: Screen): string {
  const r = rows.find((x) => x.symbol === symbol), m = r?.metrics;
  if (!r || !m) return `long term report ${symbol}: ${standing(symbol, rows, s)}`;
  const c = (id: CheckId) => r.checks.find((x) => x.id === id);
  return `long term report ${symbol}: ${standing(symbol, rows, s)} | list #${r.rank} | roe last ${m.roeLast ?? "n/a"}% ${mark(c("roe_last"))} | roe 5y ${m.roe5y ?? "n/a"}% ${mark(c("roe_5y"))} | margin ${m.margin ?? "n/a"}% ${mark(c("margin"))} | debt ${mark(c("debt"))}: ${c("debt")?.detail} | net income ${mark(c("growth"))}: ${c("growth")?.detail} | ${m.oneOff.length ? `ONE-OFF? ${m.oneOff.join("; ")}` : "no one-off tag"} | op income ${m.operatingIncome ?? "n/a"} net ${m.netIncome} ${m.currency} | fy ${m.lastYear} ${m.annualForm} | value ${usd(m.marketValue)} (${m.marketValueFrom}) | ${m.listed} | sic ${m.sic} ${m.industry}${[c("roe_last"), c("roe_5y")].some((x) => x && !x.pass && /equity/.test(x.detail)) ? ` | equity: ${c("roe_5y")?.detail}` : ""}`;
}

/**
 * One pass (its own job): the entries not read in the last 30 days, largest first, until the pass's time is up. From
 * the first trading day of January everything read before it is read again. The kept list is set only when every
 * entry has been read (never from a partial read) and this year has none yet: once now, then once each January.
 * `more`: entries are still waiting, so the next pass can start at once.
 */
export async function runLongTerm(deps: { env?: NodeJS.ProcessEnv; data?: MarketData | null; fetchImpl?: typeof fetch; now?: Date } = {}, max = LONG_TERM.perRun): Promise<{ line: string; more: boolean }> {
  // One pass at a time, so two never read the SEC side by side (the lock lapses by itself if a pass dies).
  if (!(await store.tryLock("lock:longterm:pass", 5))) return { line: "long term: another pass is running", more: false };
  try {
    return await longTermPass(deps, max);
  } finally {
    await store.unlock("lock:longterm:pass").catch(() => undefined);
  }
}

async function longTermPass(deps: { env?: NodeJS.ProcessEnv; data?: MarketData | null; fetchImpl?: typeof fetch; now?: Date }, max: number): Promise<{ line: string; more: boolean }> {
  const env = deps.env ?? process.env, fetchImpl = deps.fetchImpl ?? fetch, now = deps.now ?? new Date();
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return { line: "long term: SEC_USER_AGENT is not set", more: false };
  const universe = await longTermUniverse(env, deps.fetchImpl);
  if (!universe.length) return { line: "long term: the SEC's company list could not be read", more: false };
  // Starting over under new rules: what the older rules left is cleared, and so is anything no longer on the list.
  await q(`DELETE FROM long_term WHERE rev <> $1 OR symbol NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`, [LONG_TERM.rev, JSON.stringify(universe.map((c) => c.symbol))]);
  const done = new Map((await q(`SELECT symbol, computed_at FROM long_term`)).map((r) => [String(r.symbol), Date.parse(r.computed_at as string)]));
  const et = toEt(now), year = Number(et.date.slice(0, 4));
  // The list's year: this year once its first trading day of January has come, else last year's.
  const january = firstTradingDayOfJanuary(year), listYear = et.date >= january ? year : year - 1;
  const hasList = (await q(`SELECT 1 FROM long_term_lists WHERE year = $1 AND rev = $2`, [listYear, LONG_TERM.rev])).length > 0;
  const anyList = hasList || (await q(`SELECT 1 FROM long_term_lists WHERE rev = $1`, [LONG_TERM.rev])).length > 0;
  // A January list needs every company read again since that first trading day (midnight in New York is 05:00 UTC).
  const sinceJanuary = !hasList && anyList && et.date >= january ? Date.parse(`${january}T05:00:00Z`) : 0;
  const stale = Math.max(now.getTime() - LONG_TERM.refreshDays * 86400_000, sinceJanuary);
  const dueAll = universe.filter((c) => (done.get(c.symbol) ?? 0) < stale).sort((a, b) => (done.get(a.symbol) ?? 0) - (done.get(b.symbol) ?? 0) || a.rank - b.rank);
  const due = dueAll.slice(0, max);
  const { secFactsByCik } = await import("../sources/fmp");
  const started = Date.now();
  const day = et.date, tenBack = yearsBack(day);
  const monthBefore = new Date(Date.parse(`${tenBack}T12:00:00Z`) - 31 * 86400_000).toISOString().slice(0, 10);
  let read = 0, withReports = 0;
  type Read = { c: Listed; metrics: Metrics | null; checks: Check[]; error: string | null; removed: RemovedSector | null };
  // In blocks of 50: read each company, then price the listed ones and look up the young ones' trading together, then write the block.
  for (let i = 0; i < due.length && Date.now() - started < LONG_TERM.runSeconds * 1000; i += 50) {
    const block: Read[] = [];
    for (const c of due.slice(i, i + 50)) {
      if (Date.now() - started > LONG_TERM.runSeconds * 1000) break;
      try {
        const facts = await secFactsByCik(c.cik, env, fetchImpl);
        if (facts === "no-company") { block.push({ c, metrics: null, checks: [], removed: null, error: "no annual reports at the SEC (a fund, or a foreign company that does not report there)" }); continue; }
        if (!facts) throw new Error("the SEC did not answer");
        const r = longTermChecks(fiscalYears(facts), reportingCurrency(facts));
        if (!r) { block.push({ c, metrics: null, checks: [], removed: null, error: "no fiscal year of net income on file" }); continue; }
        const sub = await getJson<{ sic?: string; sicDescription?: string; exchanges?: Array<string | null> }>(`https://data.sec.gov/submissions/CIK${c.cik.padStart(10, "0")}.json`, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 110, cacheMs: 24 * 3600_000, fetchImpl: deps.fetchImpl, retries: 1, timeoutMs: 12_000 });
        const sic = String(sub.sic ?? "").trim() || null;
        block.push({ c, checks: r.checks, removed: removedSector(sic), error: null, metrics: { ...r.metrics, ...filingFacts(facts), sic, industry: String(sub.sicDescription ?? "").trim().toLowerCase() || null, exchanges: Array.isArray(sub.exchanges) ? sub.exchanges : null, price: null } });
      } catch (e) {
        // Not recorded: the company is tried again on a later pass.
        console.warn(`long term ${c.symbol}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      }
    }
    const listed = block.filter((x) => x.metrics && usListed(x.metrics.exchanges));
    const data = deps.data ?? null;
    type Prices = Record<string, { price: number }>;
    // No answer from the market feed: the listed companies of this block wait for a later pass (a list is never set on unpriced readings).
    const prices = data?.getSnapshots ? await batchOrEach<Prices>(listed.map((x) => x.c.symbol), (syms) => data.getSnapshots!(syms) as Promise<Prices>, (a, b2) => ({ ...a, ...b2 }), {}) : null;
    // Only a company whose first annual report on file is under ten years old needs its trading looked up.
    const unsure = listed.filter((x) => !(x.metrics!.firstAnnualFiled && x.metrics!.firstAnnualFiled <= tenBack)).map((x) => x.c.symbol);
    const tradedThen = data ? await batchOrEach<string[]>(unsure, async (syms) => [...new Set((await data.getDailyBars(syms, monthBefore, tenBack, { feed: "sip", adjustment: "raw" })).map((bar) => bar.symbol))], (a, b2) => [...a, ...b2], []) : null;
    if (listed.length && (!prices || !tradedThen)) console.warn(`long term: the market feed did not answer (${!prices ? "prices" : "trading ten years back"}); ${listed.length} companies wait for a later pass`);
    for (const x of block) {
      if (x.metrics) {
        const m = x.metrics, isListed = usListed(m.exchanges);
        if (isListed && (!prices || !tradedThen)) continue;
        m.price = prices?.[x.c.symbol]?.price ?? null;
        Object.assign(m, marketValueOf(m.price, { annualForm: m.annualForm ?? null, sharesOut: m.sharesOut ?? null, sharesOutAt: m.sharesOutAt ?? null }, m.shares));
        Object.assign(m, listingAge(m.firstAnnualFiled ?? null, isListed && unsure.includes(x.c.symbol) ? tradedThen!.includes(x.c.symbol) : null, day));
        withReports++;
      }
      read++;
      await q(
        `INSERT INTO long_term (symbol, sector, name, computed_at, metrics, checks, error, rev, cik, rank) VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)
         ON CONFLICT (symbol) DO UPDATE SET sector = EXCLUDED.sector, name = EXCLUDED.name, computed_at = now(), metrics = EXCLUDED.metrics, checks = EXCLUDED.checks, error = EXCLUDED.error, rev = EXCLUDED.rev, cik = EXCLUDED.cik, rank = EXCLUDED.rank`,
        [x.c.symbol, x.removed, nice(x.c.name), x.metrics ? JSON.stringify(x.metrics) : null, JSON.stringify(x.checks), x.error, LONG_TERM.rev, x.c.cik, x.c.rank],
      );
    }
  }
  const left = dueAll.length - read;
  const rows = await longTermRows();
  const state = readState(universe, rows);
  // Whole: every entry has a reading under these rules, and none is waiting to be read again.
  const whole = state.complete && left === 0;
  if (!whole) return { line: `long term: ${read} entries read, ${withReports} with annual reports, ${left} still to read (${state.read} of ${state.total} on file)`, more: left > 0 && read > 0 };
  const s = screen(rows);
  // The reconciliation lines, once per whole read of a set of rules (and again when `reportRev` is raised).
  if (await store.tryLock(`longterm:report:r${LONG_TERM.rev}:${LONG_TERM.reportRev}`, 60 * 24 * 60)) {
    for (const sym of LONG_TERM.report) console.log(reportLine(sym, rows, s));
    const c = s.cutoff;
    console.log(`long term cut-off: company ${s.pool.length} is ${c.last?.symbol} (list #${c.last?.rank}) value ${usd(c.last?.marketValue)} (${c.last?.marketValueFrom}) · last 25 of the pool: ${c.computed} computed, low ${usd(c.low)} middle ${usd(c.mid)} high ${usd(c.high)} · outside the pool above the middle: ${c.outsideAbove.length} (${c.outsideAbove.slice(0, 12).map((x) => `${x.symbol} #${x.rank} ${usd(x.marketValue)}`).join(", ")}) · inside under half: ${c.insideBelowHalf} · foreign annual filers in the pool: ${c.foreignFilers}`);
    console.log(`long term narrowing: pool ${s.pool.length}; under $${LONG_TERM.minPrice}: ${s.underPrice.length}; removed sectors: ${s.removedSector.length}; listed under ${LONG_TERM.minListedYears} years: ${s.young.length} (${s.young.slice(0, 40).map((r) => r.symbol).join(" ")}); checked ${s.checked}; failed ${CHECK_ORDER.map((id) => `${id} ${s.failed[id]}`).join(", ")}; pass all five ${s.passers.length}`);
    console.log(`long term passers: ${s.passers.map((r, k) => `${k + 1} ${r.symbol} ${r.metrics!.roe5y}%${r.metrics!.oneOff.length ? " (one-off?)" : ""}${r.metrics!.debt === null ? " (debt by ceiling)" : ""}`).join(", ")}`);
  }
  let kept = "";
  if (LONG_TERM.setList && !hasList && s.top.length && (!sinceJanuary || rows.every((r) => Date.parse(r.computedAt) >= sinceJanuary))) {
    await q(
      `INSERT INTO long_term_lists (year, rev, picks, counts) VALUES ($1, $2, $3, $4) ON CONFLICT (year) DO UPDATE SET rev = EXCLUDED.rev, picks = EXCLUDED.picks, counts = EXCLUDED.counts, set_at = now() WHERE long_term_lists.rev <> EXCLUDED.rev`,
      [listYear, LONG_TERM.rev, JSON.stringify(s.top), JSON.stringify({ pool: s.pool.length, passers: s.passers.length })],
    );
    kept = ` · list for ${listYear} kept: ${s.top.map((r) => r.symbol).join(", ")}`;
  }
  if (!read && !kept) return { line: `long term: all ${universe.length} entries read in the last ${LONG_TERM.refreshDays} days`, more: false };
  return { line: `long term: ${read} entries read, ${withReports} with annual reports, 0 still to read · pool ${s.pool.length} of ${LONG_TERM.pool}; passing all five: ${s.passers.length}; top now: ${s.top.map((r) => r.symbol).join(", ") || "none"}${kept}`, more: false };
}
