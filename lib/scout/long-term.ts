/**
 * Long term: a fixed quality screen, run on the companies' own annual reports.
 *
 * Starting pool: the 1,000 largest US-listed companies by market value (foreign companies listed in the US
 * included), share price $5 or more. A company must pass all five: return on equity 20% or more in the last fiscal
 * year, 20% or more on the five-year average, net profit margin 15% or more, long-term debt no more than half of
 * shareholders' equity (banks included), and net income higher than five years earlier. Energy, utilities, real
 * estate and basic materials are removed. What is left is ranked by five-year average return on equity and the top
 * 25 are kept at equal weight, one share class per company. The list is set once, then again every January.
 *
 * Where the figures come from: the SEC's size-ordered list of listed companies, each company's annual-report data
 * (XBRL), its industry code and exchange from the SEC's company record, and the price from the market feed. No AI,
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
  /** Fiscal years read per company (five for the average, one more for its opening equity and for "five years earlier"). */
  yearsRead: 8,
  perRun: 700, refreshDays: 30, runSeconds: 200,
  /** Raise when the rules change: every company is then screened again and the kept list is set again. */
  rev: 6,
  /** Always written into the pass's log line when read, to check foreign filers by eye. */
  watch: ["TSM", "ASML", "NVO", "TM", "SAP", "BABA", "PDD", "RY", "HSBC", "AZN", "SHEL", "BRK.B"],
};

type Facts = Record<string, Record<string, { units?: Record<string, Fact[]> }>>;
export interface FiscalYear { end: string; netIncome: number | null; revenue: number | null; equity: number | null; debt: number | null; cashFromOps: number | null; capex: number | null; shares: number | null }

const NET_INCOME = ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"];
const EQUITY = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "EquityAttributableToOwnersOfParent", "Equity"];
const DEBT = ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtFairValue", "DebtLongtermAndShorttermCombinedAmount", "ConvertibleNotesPayable", "ConvertibleDebtNoncurrent", "OtherLongTermDebtNoncurrent", "SubordinatedDebt", "FederalHomeLoanBankAdvancesLongTerm", "NotesAndLoansPayable", "LoansPayable", "OtherBorrowings", "OtherLongTermDebt", "BondsIssued", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "DebtAndCapitalLeaseObligations", "DebtInstrumentCarryingAmount", "LongTermNotesPayable", "SeniorNotes", "SeniorLongTermNotes", "UnsecuredLongTermDebt", "SecuredLongTermDebt", "SecuredDebt", "NotesPayable", "ConvertibleNotesPayableNoncurrent", "LongTermLineOfCredit", "NoncurrentPortionOfNoncurrentBondsIssued", "Borrowings", "LongtermBorrowings"];
const CASH_OPS = ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", "CashFlowsFromUsedInOperatingActivities"];
const CAPEX = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"];
const SHARES = ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic", "WeightedAverageShares"];

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
 * Pure: long-term debt on a date: the largest of the debt lines the company reports there. Companies tag their debt
 * under different names and often tag a small part separately; the first name found read Marriott's and Domino's
 * debt as nothing. The largest line is the total, or the nearest thing to it that is reported.
 */
function debtAt(facts: Facts, end: string): number | null {
  const found = DEBT.map((n) => instantAt(facts, [n], end)).filter((v): v is number => v !== null);
  return found.length ? Math.max(...found) : null;
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

/** Pure: the company's fiscal years on file (up to ten, oldest first), from its annual net income. */
export function fiscalYears(all: Facts): FiscalYear[] {
  const unit = reportingCurrency(all);
  const facts = unit ? inCurrency(all, unit) : all;
  const ni = pickFacts(facts, NET_INCOME);
  if (!ni) return [];
  const rev = pickRevenue(facts, "annual");
  const revRows = rev ? periodFacts(rev.rows, "annual", 40) : [];
  return periodFacts(ni.rows, "annual", LONG_TERM.yearsRead).map((y) => ({
    end: y.end, netIncome: y.val, revenue: revRows.find((r) => r.end === y.end)?.val ?? null,
    equity: instantAt(facts, EQUITY, y.end), debt: debtAt(facts, y.end),
    cashFromOps: yearAt(facts, CASH_OPS, y.end), capex: yearAt(facts, CAPEX, y.end), shares: yearAt(facts, SHARES, y.end, (u) => u === "shares"),
  }));
}


export type RemovedSector = "energy" | "utilities" | "real estate" | "basic materials";
export const REMOVED_SECTORS: RemovedSector[] = ["energy", "utilities", "real estate", "basic materials"];

/**
 * Pure: the removed sector an SEC industry code (SIC) belongs to, or null when the company stays.
 * Energy: coal, oil and gas production and services, refining, pipelines, oilfield machinery, fuel wholesale, oil
 * royalties. Utilities: electric, gas distribution, water, steam (waste haulers stay). Real estate: property
 * owners, agents, developers and property trusts. Basic materials: mining, quarrying, lumber, paper mills,
 * chemicals (not drugs or soap), paint, fertiliser, cement and stone, steel and other primary metals.
 */
export function removedSector(sic: string | null | undefined): RemovedSector | null {
  const n = Number(sic);
  if (!sic || !Number.isFinite(n) || n <= 0) return null;
  const in_ = (a: number, b: number) => n >= a && n <= b;
  if (in_(1200, 1399) || in_(2900, 2999) || in_(4600, 4619) || n === 4922 || n === 4923 || n === 3533 || in_(5170, 5172) || n === 6792) return "energy";
  if (in_(4900, 4949) || in_(4960, 4991)) return "utilities";
  if (in_(6500, 6599) || n === 6798) return "real estate";
  if (in_(1000, 1099) || in_(1400, 1499) || in_(2400, 2449) || in_(2600, 2631) || in_(2800, 2829) || in_(2850, 2899) || in_(3240, 3299) || in_(3310, 3356) || in_(3360, 3399)) return "basic materials";
  return null;
}

/** Pure: listed on a US exchange, from the SEC record's exchange names. Only "over the counter and nowhere else" is a no; no record is not. */
export function usListed(exchanges: Array<string | null> | null | undefined): boolean {
  const named = (exchanges ?? []).filter((e): e is string => !!e && !!e.trim());
  return !named.length || named.some((e) => !/^otc/i.test(e.trim()));
}

export type CheckId = "roe_last" | "roe_5y" | "margin" | "debt" | "growth";
export const CHECK_ORDER: CheckId[] = ["roe_last", "roe_5y", "margin", "debt", "growth"];
/** `pass` null: the check could not be made from what the company reports. Only a true passes. */
export interface Check { id: CheckId; pass: boolean | null; detail: string }
export const CHECK_LABEL: Record<CheckId, string> = {
  roe_last: "Return on equity, last year", roe_5y: "Return on equity, five-year average", margin: "Net profit margin", debt: "Long-term debt against equity", growth: "Net income against five years earlier",
};
export const CHECK_ABOUT: Record<CheckId, string> = {
  roe_last: `Net income of the last fiscal year as a share of shareholders' equity (the average of the year's opening and closing equity): ${LONG_TERM.roe}% or more.`,
  roe_5y: `The same figure for each of the last ${LONG_TERM.years} fiscal years, averaged: ${LONG_TERM.roe}% or more. A year with equity at or below zero cannot be measured, and the company does not pass.`,
  margin: `Net income of the last fiscal year as a share of its sales: ${LONG_TERM.margin}% or more. For a bank, sales are interest income plus other income.`,
  debt: `Long-term debt at the last fiscal year end is no more than ${Math.round(LONG_TERM.debtToEquity * 100)}% of shareholders' equity. Asked of every company, banks included. A company that reports no long-term debt passes.`,
  growth: "Net income of the last fiscal year is higher than in the fiscal year five years before it.",
};

export interface Metrics {
  years: number; lastYear: string;
  roeLast: number | null; roe5y: number | null; margin: number | null; debtToEquity: number | null;
  netIncome: number; netIncome5yAgo: number | null; year5yAgo: string | null;
  shares: number | null;
  /** The currency the company reports in (a price in dollars cannot be set against profit in another currency). */
  currency?: string | null;
  /** From the SEC's company record: industry code and name, and where it is listed. */
  sic?: string | null; industry?: string | null; exchanges?: Array<string | null> | null;
  /** The share price when the company was screened (null: the market feed had none). */
  price?: number | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const YEAR_MS = 365.25 * 86400_000;

/** Pure: the five checks for one company, from its fiscal years (oldest first). Null with no fiscal year of net income on file. */
export function longTermChecks(years: FiscalYear[], currency: string | null = "USD"): { metrics: Metrics; checks: Check[] } | null {
  const ys = years.filter((y) => y.netIncome !== null);
  if (!ys.length) return null;
  const last = ys[ys.length - 1];
  const checks: Check[] = [];

  // Return on equity for a year: net income over the average of opening and closing equity (closing alone when there is no year before).
  const roeOf = (i: number): number | "negative" | null => {
    const close = ys[i].equity, open = i > 0 ? ys[i - 1].equity : null;
    if (close === null) return null;
    if (close <= 0 || (open !== null && open <= 0)) return "negative";
    return (ys[i].netIncome! / ((close + (open ?? close)) / 2)) * 100;
  };
  const lastRoe = roeOf(ys.length - 1);
  const roeLast = typeof lastRoe === "number" ? r1(lastRoe) : null;
  checks.push({ id: "roe_last", pass: roeLast === null ? null : roeLast >= LONG_TERM.roe, detail: roeLast !== null ? `${roeLast}% in ${last.end.slice(0, 4)}` : lastRoe === "negative" ? "shareholders' equity is at or below zero, so a return on it cannot be measured" : "shareholders' equity is not reported" });

  // The five-year average: the last five fiscal years, which have to be five years in a row.
  const five = ys.slice(-LONG_TERM.years);
  const inARow = five.length === LONG_TERM.years && Math.abs((Date.parse(last.end) - Date.parse(five[0].end)) / YEAR_MS - (LONG_TERM.years - 1)) < 0.2;
  const roes = five.map((_, k) => roeOf(ys.length - five.length + k));
  const roe5y = inARow && roes.every((x): x is number => typeof x === "number") ? r1(roes.reduce((a: number, b) => a + (b as number), 0) / roes.length) : null;
  checks.push({ id: "roe_5y", pass: roe5y === null ? null : roe5y >= LONG_TERM.roe, detail: roe5y !== null ? `${roe5y}% on average, ${five[0].end.slice(0, 4)} to ${last.end.slice(0, 4)}` : !inARow ? `fewer than ${LONG_TERM.years} fiscal years in a row on file` : roes.includes("negative") ? "shareholders' equity was at or below zero in one of the five years" : "shareholders' equity is not reported for all five years" });

  // Margin over 100% means the sales line found does not match the profit (or a one-off gain larger than sales): not a measurement.
  const rawMargin = last.revenue && last.revenue > 0 ? (last.netIncome! / last.revenue) * 100 : null;
  const margin = rawMargin !== null && rawMargin <= 100 ? r1(rawMargin) : null;
  checks.push({ id: "margin", pass: margin === null ? null : margin >= LONG_TERM.margin, detail: margin !== null ? `${margin}% of sales in ${last.end.slice(0, 4)}` : rawMargin !== null ? "net income is larger than the sales line on file, so the margin cannot be measured" : "sales are not reported" });

  // No long-term debt line at all is read as no long-term debt.
  const debt = last.debt ?? 0;
  const debtToEquity = last.equity !== null && last.equity > 0 ? r2(debt / last.equity) : null;
  checks.push({ id: "debt", pass: last.equity === null ? null : last.equity <= 0 ? false : debtToEquity! <= LONG_TERM.debtToEquity, detail: last.equity === null ? "shareholders' equity is not reported" : last.equity <= 0 ? "shareholders' equity is at or below zero" : last.debt === null ? "no long-term debt reported" : `long-term debt is ${Math.round(debtToEquity! * 100)}% of equity` });

  const t5 = Date.parse(last.end) - LONG_TERM.years * YEAR_MS;
  const ago = ys.find((y) => Math.abs(Date.parse(y.end) - t5) <= 45 * 86400_000) ?? null;
  checks.push({ id: "growth", pass: ago ? last.netIncome! > ago.netIncome! : null, detail: ago ? `${last.netIncome! > ago.netIncome! ? "higher" : "not higher"} than in ${ago.end.slice(0, 4)}` : `no fiscal year ${LONG_TERM.years} years before ${last.end.slice(0, 4)} on file` });

  return { metrics: { years: ys.length, lastYear: last.end, roeLast, roe5y, margin, debtToEquity, netIncome: last.netIncome!, netIncome5yAgo: ago?.netIncome ?? null, year5yAgo: ago?.end ?? null, shares: last.shares, currency }, checks };
}

/** Pure: does the company pass all five? */
export const passesAll = (checks: Check[]) => CHECK_ORDER.every((id) => checks.find((c) => c.id === id)?.pass === true);

/**
 * Pure: the price against last year's profit, for information (it is not part of the screen). Market value is the
 * price times the year's average diluted share count; a ratio under 2 or over 200 is treated as a data problem (a
 * split since the year end), and a company reporting in another currency has none.
 */
export function priceOf(m: Pick<Metrics, "netIncome" | "shares" | "currency">, price: number | null): number | null {
  if (!price || !m.shares || m.netIncome <= 0 || (m.currency && m.currency !== "USD")) return null;
  const pe = (price * m.shares) / m.netIncome;
  return pe < 2 || pe > 200 ? null : r1(pe);
}

export interface LongTermRow { symbol: string; name: string | null; /** Place on the SEC's size-ordered list (1 is the largest). */ rank: number | null; computedAt: string; metrics: Metrics | null; checks: Check[]; removed: RemovedSector | null; error: string | null }

export interface Screen {
  /** Companies read so far that count toward the pool, and the pool itself (the largest 1,000 of them). */
  companies: number; pool: LongTermRow[];
  underPrice: LongTermRow[]; removedSector: LongTermRow[];
  /** Of the companies left after price and sector: how many did not pass each check. */
  failed: Record<CheckId, number>; checked: number;
  /** Passing all five, best five-year return on equity first; `top` is the first 25. */
  passers: LongTermRow[]; top: LongTermRow[];
}

/** Pure: the whole screen from the rows on file. */
export function screen(rows: LongTermRow[]): Screen {
  const companies = rows.filter((r) => r.metrics && usListed(r.metrics.exchanges)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const pool = companies.slice(0, LONG_TERM.pool);
  const underPrice = pool.filter((r) => typeof r.metrics!.price === "number" && r.metrics!.price < LONG_TERM.minPrice);
  const priced = pool.filter((r) => !underPrice.includes(r));
  const removed = priced.filter((r) => r.removed);
  const left = priced.filter((r) => !r.removed);
  const failed = Object.fromEntries(CHECK_ORDER.map((id) => [id, left.filter((r) => r.checks.find((c) => c.id === id)?.pass !== true).length])) as Record<CheckId, number>;
  const passers = left.filter((r) => passesAll(r.checks)).sort((a, b) => (b.metrics!.roe5y ?? 0) - (a.metrics!.roe5y ?? 0) || (a.rank ?? 0) - (b.rank ?? 0));
  return { companies: companies.length, pool, underPrice, removedSector: removed, failed, checked: left.length, passers, top: passers.slice(0, LONG_TERM.keep) };
}

export interface ListPick { symbol: string; name: string | null; roe5y: number | null; roeLast: number | null; margin: number | null; debtToEquity: number | null; price: number | null }
export interface KeptList { year: number; setAt: string; picks: ListPick[]; counts: { pool: number; passers: number } | null }

/** Pure: what a re-run today would change in the kept list. */
export function listChanges(kept: ListPick[], top: LongTermRow[]): { join: LongTermRow[]; leave: ListPick[] } {
  const now = new Set(top.map((r) => r.symbol)), had = new Set(kept.map((p) => p.symbol));
  return { join: top.filter((r) => !had.has(r.symbol)), leave: kept.filter((p) => !now.has(p.symbol)) };
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

const UNIVERSE_KEY = `longterm:universe:${LONG_TERM.scan}`;
/** The list being read, kept for a week (the SEC's file is about a megabyte). */
export async function longTermUniverse(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<Listed[]> {
  const hit = await store.cacheGet<Listed[]>(UNIVERSE_KEY).catch(() => null);
  if (hit?.data?.length && Date.now() - Date.parse(hit.updatedAt) < 7 * 86400_000) return hit.data;
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return hit?.data ?? [];
  const { secTickerList } = await import("../sources/edgar");
  const list = largestCompanies(await secTickerList(ua, fetchImpl));
  if (list.length) await store.cachePut(UNIVERSE_KEY, list).catch(() => undefined);
  return list.length ? list : hit?.data ?? [];
}

/** A listed name as people write it ("APPLE INC" → "Apple Inc"). */
const nice = (t: string) => (t === t.toUpperCase() ? t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t);

const toRow = (r: Record<string, unknown>): LongTermRow => ({
  symbol: String(r.symbol), name: (r.name as string) ?? null, rank: r.rank === null || r.rank === undefined ? null : Number(r.rank), computedAt: new Date(r.computed_at as string).toISOString(),
  metrics: (r.metrics as Metrics) ?? null, checks: (r.checks as Check[]) ?? [], removed: REMOVED_SECTORS.includes(r.sector as RemovedSector) ? (r.sector as RemovedSector) : null, error: (r.error as string) ?? null,
});

/** Every entry read under the current rules (rows from older rules are not shown while they wait to be redone). */
export async function longTermRows(): Promise<LongTermRow[]> {
  return (await q(`SELECT * FROM long_term WHERE rev = $1 ORDER BY rank`, [LONG_TERM.rev])).map(toRow);
}

/** The kept lists under the current rules, newest first. */
export async function keptLists(): Promise<KeptList[]> {
  return (await q(`SELECT year, set_at, picks, counts FROM long_term_lists WHERE rev = $1 ORDER BY year DESC`, [LONG_TERM.rev])).map((r) => ({ year: Number(r.year), setAt: new Date(r.set_at as string).toISOString(), picks: (r.picks as ListPick[]) ?? [], counts: (r.counts as KeptList["counts"]) ?? null }));
}

const toPick = (r: LongTermRow): ListPick => ({ symbol: r.symbol, name: r.name, roe5y: r.metrics!.roe5y, roeLast: r.metrics!.roeLast, margin: r.metrics!.margin, debtToEquity: r.metrics!.debtToEquity, price: r.metrics!.price ?? null });

/**
 * One pass (its own job): the entries not read in the last 30 days, largest first, until the pass's time is up. In
 * January everything read before the new year is read again. When the whole list has been read and this year has
 * no kept list yet, the top 25 are kept: once now, then once every January.
 */
export async function runLongTerm(deps: { env?: NodeJS.ProcessEnv; data?: MarketData | null; fetchImpl?: typeof fetch; now?: Date } = {}, max = LONG_TERM.perRun): Promise<string> {
  const env = deps.env ?? process.env, fetchImpl = deps.fetchImpl ?? fetch, now = deps.now ?? new Date();
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return "long term: SEC_USER_AGENT is not set";
  const universe = await longTermUniverse(env, deps.fetchImpl);
  if (!universe.length) return "long term: the SEC's company list could not be read";
  // Starting over under new rules: what the older rules left is cleared.
  await q(`DELETE FROM long_term WHERE rev <> $1`, [LONG_TERM.rev]);
  const done = new Map((await q(`SELECT symbol, computed_at FROM long_term`)).map((r) => [String(r.symbol), Date.parse(r.computed_at as string)]));
  const et = toEt(now), year = Number(et.date.slice(0, 4));
  const newYear = et.date.slice(5, 7) === "01" ? Date.parse(`${year}-01-01T05:00:00Z`) : 0;
  const stale = Math.max(now.getTime() - LONG_TERM.refreshDays * 86400_000, newYear);
  const dueAll = universe.filter((c) => (done.get(c.symbol) ?? 0) < stale).sort((a, b) => (done.get(a.symbol) ?? 0) - (done.get(b.symbol) ?? 0) || a.rank - b.rank);
  const due = dueAll.slice(0, max);
  const { secFactsByCik } = await import("../sources/fmp");
  const started = Date.now();
  let read = 0, withReports = 0;
  const seen: string[] = [];
  type Read = { c: Listed; metrics: Metrics | null; checks: Check[]; error: string | null; removed: RemovedSector | null };
  // In blocks of 50: read each company, then price the listed ones together, then write the block.
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
        block.push({ c, checks: r.checks, removed: removedSector(sic), error: null, metrics: { ...r.metrics, sic, industry: String(sub.sicDescription ?? "").trim().toLowerCase() || null, exchanges: Array.isArray(sub.exchanges) ? sub.exchanges : null, price: null } });
      } catch (e) {
        // Not recorded: the company is tried again on a later pass.
        console.warn(`long term ${c.symbol}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      }
    }
    const listed = block.filter((x) => x.metrics && usListed(x.metrics.exchanges)).map((x) => x.c.symbol);
    const prices = (listed.length && deps.data?.getSnapshots ? await deps.data.getSnapshots(listed).catch(() => ({})) : {}) as Record<string, { price: number }>;
    for (const x of block) {
      if (x.metrics) {
        x.metrics.price = prices[x.c.symbol]?.price ?? null;
        withReports++;
        // A compact reading for the first few of a pass, so the numbers can be checked by eye in the log.
        if (seen.length < 8 || LONG_TERM.watch.includes(x.c.symbol)) seen.push(`${x.c.symbol} #${x.c.rank} ${passesAll(x.checks) ? "PASS" : "no"}${x.removed ? ` [${x.removed}]` : ""} (roe ${x.metrics.roeLast ?? "?"}% / 5y ${x.metrics.roe5y ?? "?"}%, margin ${x.metrics.margin ?? "?"}%, debt/equity ${x.metrics.debtToEquity ?? "?"}, 5y ago ${x.checks.find((k) => k.id === "growth")?.pass ?? "?"}, $${x.metrics.price ?? "?"}, ${x.metrics.currency ?? "?"}, sic ${x.metrics.sic ?? "?"}, ${[...new Set(x.metrics.exchanges ?? [])].join("/") || "?"})`);
      } else if (LONG_TERM.watch.includes(x.c.symbol)) seen.push(`${x.c.symbol} #${x.c.rank}: ${x.error}`);
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
  const s = screen(rows);
  // The watched names as they stand on file, on a line of their own (the pass's own line is too long to read them from).
  console.log(`long term lookup: ${universe.filter((c) => /taiwan semi/i.test(c.name) || c.cik === "1046179" || c.rank === 14 || /^TSM/.test(c.symbol)).map((c) => `${c.symbol} #${c.rank} cik ${c.cik} "${c.name}"`).join(" | ") || "nothing like TSMC among the entries read"} · ${universe.length} entries, last ${universe.at(-1)?.symbol} #${universe.at(-1)?.rank}`);
  if (read) console.log(`long term watch: ${LONG_TERM.watch.map((w) => { const r = rows.find((x) => x.symbol === w); const m = r?.metrics; return !r ? `${w} not read yet` : !m ? `${w} #${r.rank}: ${r.error}` : `${w} #${r.rank} ${passesAll(r.checks) ? "PASS" : "no"}${r.removed ? ` [${r.removed}]` : ""} roe ${m.roeLast ?? "?"}/${m.roe5y ?? "?"} margin ${m.margin ?? "?"} d/e ${m.debtToEquity ?? "?"} ${m.currency ?? "?"} ${m.years}y to ${m.lastYear}`; }).join(" | ")}`);
  // The list is kept once the whole list has been read (a handful the SEC will not answer for do not hold it up).
  let kept = "";
  if (left <= universe.length * 0.01 && s.top.length && !(await q(`SELECT 1 FROM long_term_lists WHERE year = $1 AND rev = $2`, [year, LONG_TERM.rev])).length) {
    await q(
      `INSERT INTO long_term_lists (year, rev, picks, counts) VALUES ($1, $2, $3, $4) ON CONFLICT (year) DO UPDATE SET rev = EXCLUDED.rev, picks = EXCLUDED.picks, counts = EXCLUDED.counts, set_at = now()`,
      [year, LONG_TERM.rev, JSON.stringify(s.top.map(toPick)), JSON.stringify({ pool: s.pool.length, passers: s.passers.length })],
    );
    kept = ` · list for ${year} kept: ${s.top.map((r) => r.symbol).join(", ")}`;
  }
  if (!due.length && !kept) return `long term: all ${universe.length} entries read in the last ${LONG_TERM.refreshDays} days`;
  return `long term: ${read} entries read, ${withReports} with annual reports, ${left} still to read · pool ${s.pool.length} of ${LONG_TERM.pool}; under $${LONG_TERM.minPrice}: ${s.underPrice.length}; removed sectors: ${s.removedSector.length}; passing all five: ${s.passers.length}; top now: ${s.top.map((r) => `${r.symbol} ${r.metrics!.roe5y}%`).join(", ") || "none"}${kept}${seen.length ? ` · ${seen.join("; ")}` : ""}`;
}
