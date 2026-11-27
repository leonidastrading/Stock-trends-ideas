/**
 * Long term: companies that pass a Warren Buffett style check of their own filings.
 *
 * What he has said he looks for, as far as numbers can show it: a business that earns a high return on its owners'
 * money year after year, makes money every year, grows, carries little debt, turns its profits into cash, keeps a
 * good share of each sales dollar, and does not water down its owners. Then a sensible price ("a wonderful company
 * at a fair price"). The 3,000 largest companies on the SEC's own list of listed companies (it is ordered by size)
 * are each checked by code against up to ten fiscal years of their annual reports (the SEC's XBRL data). No AI,
 * nothing traded.
 *
 * What a screen cannot judge, and he weighs most: whether the advantage will last (the moat), whether management is
 * able and honest, and whether you understand the business. A pass here is a short list to read about, not a buy.
 *
 * Banks, insurers and property trusts: debt, free cash flow and margin mean something else for them, so those three
 * checks are left out and they are judged on return on equity (a lower bar), steady profit, growth and dilution.
 */
import { SECTORS, type Sector } from "@/config/scout";
import { UNIVERSE } from "@/config/universe";
import { query as q } from "../db";
import { periodFacts, pickFacts, pickRevenue, type Fact } from "../sources/fmp";
import * as store from "./store";

export const LONG_TERM = {
  minYears: 5, maxYears: 10,
  roe: 15, roeFinancial: 10, roeFloor: 12, roeFloorShare: 0.8,
  growth: 5, debtYears: 4, cashShare: 0.7, cashYears: 0.9, margin: 10, dilution: 5,
  /** A price-to-earnings ratio at or under this is "fair" here; over `rich` is expensive. */
  fairPe: 25, richPe: 35,
  /** How many companies are screened: the largest on the SEC's list, one share class each. */
  size: 3000,
  /** A company takes about an eighth of a second to read, so a pass is bounded by its time, not this count. */
  perRun: 400, refreshDays: 30, runSeconds: 200,
  /** Raise when the checks change: every company is then screened again, not left for a month on the old reading. */
  rev: 3,
  /** A return on equity above this means equity has been bought back to almost nothing: the figure says little. */
  roeMeaningless: 100,
};

type Facts = Record<string, Record<string, { units?: Record<string, Fact[]> }>>;
export interface FiscalYear { end: string; netIncome: number | null; revenue: number | null; equity: number | null; debt: number | null; cashFromOps: number | null; capex: number | null; shares: number | null }

const NET_INCOME = ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"];
const EQUITY = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "EquityAttributableToOwnersOfParent", "Equity"];
const DEBT = ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations", "LongTermNotesPayable", "SeniorNotes", "NoncurrentPortionOfNoncurrentBondsIssued", "Borrowings"];
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

/** Pure: a full-year figure for the year ending on a date. */
function yearAt(facts: Facts, names: string[], end: string, unitOk: (u: string) => boolean = (u) => !u.includes("/")): number | null {
  for (const tax of ["us-gaap", "ifrs-full"]) for (const n of names) for (const [unit, rows] of Object.entries(facts[tax]?.[n]?.units ?? {})) {
    if (!unitOk(unit) || !Array.isArray(rows)) continue;
    const hit = periodFacts(rows, "annual", 40).find((r) => r.end === end);
    if (hit) return hit.val;
  }
  return null;
}

/** Pure: the currency the company reports its net income in. */
export const reportingCurrency = (facts: Facts): string | null => pickFacts(facts, NET_INCOME)?.unit ?? null;

/** Pure: the company's fiscal years on file (up to ten, oldest first), from its annual net income. */
export function fiscalYears(facts: Facts): FiscalYear[] {
  const ni = pickFacts(facts, NET_INCOME);
  if (!ni) return [];
  const rev = pickRevenue(facts, "annual");
  const revRows = rev ? periodFacts(rev.rows, "annual", 40) : [];
  return periodFacts(ni.rows, "annual", LONG_TERM.maxYears).map((y) => ({
    end: y.end, netIncome: y.val, revenue: revRows.find((r) => r.end === y.end)?.val ?? null,
    equity: instantAt(facts, EQUITY, y.end), debt: instantAt(facts, DEBT, y.end),
    cashFromOps: yearAt(facts, CASH_OPS, y.end), capex: yearAt(facts, CAPEX, y.end), shares: yearAt(facts, SHARES, y.end, (u) => u === "shares"),
  }));
}

/**
 * Pure: the share counts with stock splits taken out. A count that jumps by 40% or more in a year (or falls by 30%
 * or more) is a split, not issuance: later years are put back on the earlier basis so the change shows real dilution.
 */
export function splitFreeShares(shares: Array<number | null>): Array<number | null> {
  let factor = 1, prev: number | null = null;
  return shares.map((s) => {
    if (s === null || s <= 0) return null;
    if (prev !== null) { const r = s / factor / prev; if (r >= 1.4 || r <= 0.7) factor *= r; }
    const v = s / factor;
    prev = v;
    return v;
  });
}

export type CheckId = "returns" | "profitable" | "growth" | "debt" | "cash" | "margin" | "dilution";
export interface Check { id: CheckId; pass: boolean | null; detail: string }
export const CHECK_LABEL: Record<CheckId, string> = {
  returns: "High return on owners' money", profitable: "Profit every year", growth: "Earnings grew", debt: "Little debt",
  cash: "Profits arrive as cash", margin: "Keeps a good share of sales", dilution: "Does not water down owners",
};
export const CHECK_ABOUT: Record<CheckId, string> = {
  returns: `Net income as a share of shareholders' equity: ${LONG_TERM.roe}% or more on average, and ${LONG_TERM.roeFloor}% or more in four years of five (${LONG_TERM.roeFinancial}% on average for banks and insurers).`,
  profitable: "Net income above zero in every fiscal year on file.",
  growth: `Net income grew ${LONG_TERM.growth}% a year or more over the years on file, and the latest year is above the one five years before.`,
  debt: `Long-term debt is no more than ${LONG_TERM.debtYears} years of net income. Not asked of banks, insurers and property trusts.`,
  cash: `Cash from operations less capital spending was positive in nine years of ten, and added up to ${Math.round(LONG_TERM.cashShare * 100)}% or more of reported profit. Not asked of banks, insurers and property trusts.`,
  margin: `Net income is ${LONG_TERM.margin}% of sales or more on average. Not asked of banks, insurers and property trusts.`,
  dilution: `The share count is not up more than ${LONG_TERM.dilution}% over five years (stock splits taken out).`,
};

export interface Metrics {
  years: number; firstYear: string; lastYear: string;
  avgRoe: number | null; minRoe: number | null; growthPct: number | null; debtYears: number | null; cashShare: number | null; avgMargin: number | null; sharesPct5y: number | null;
  netIncome: number; freeCash: number | null; shares: number | null;
  /** The currency the company reports in (a price in dollars cannot be set against profit in another currency). */
  currency?: string | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const ASSET_HEAVY: Sector[] = ["financials", "real_estate"];

/**
 * Pure: the numbers and the checks for one company. `pass` is null when a check cannot be made (too few years, a
 * figure the company does not report, equity below zero after buybacks) or is not asked of its kind of business.
 */
export function longTermChecks(years: FiscalYear[], sector: Sector | null, currency: string | null = "USD"): { metrics: Metrics; checks: Check[] } | null {
  const ys = years.filter((y) => y.netIncome !== null);
  if (ys.length < LONG_TERM.minYears) return null;
  const last = ys[ys.length - 1], first = ys[0];
  const special = !!sector && ASSET_HEAVY.includes(sector);
  const checks: Check[] = [];

  // Return on equity, on the average of the year's opening and closing equity.
  const roes: number[] = [];
  let negativeEquity = false;
  ys.forEach((y, i) => {
    const open = i > 0 ? ys[i - 1].equity : y.equity, close = y.equity;
    if (close === null) return;
    if (close <= 0 || (open !== null && open <= 0)) { negativeEquity = true; return; }
    roes.push((y.netIncome! / ((close + (open ?? close)) / 2)) * 100);
  });
  // Equity bought back to nothing (or below zero) makes the return on it meaningless: no figure is shown for it.
  const hollow = negativeEquity || roes.some((x) => x > LONG_TERM.roeMeaningless);
  const avgRoe = roes.length && !hollow ? r1(mean(roes)) : null, minRoe = roes.length && !hollow ? r1(Math.min(...roes)) : null;
  const bar = special ? LONG_TERM.roeFinancial : LONG_TERM.roe;
  if (hollow) checks.push({ id: "returns", pass: null, detail: negativeEquity ? "shareholders' equity is below zero in some years (usually after large buybacks), so a return on it cannot be measured" : "the return on equity is over 100% in some years (equity is small against profit, often after buybacks), so the figure says little" });
  else if (roes.length < LONG_TERM.minYears) checks.push({ id: "returns", pass: null, detail: "equity is not reported for enough years" });
  else {
    const steady = special || roes.filter((x) => x >= LONG_TERM.roeFloor).length / roes.length >= LONG_TERM.roeFloorShare;
    checks.push({ id: "returns", pass: avgRoe! >= bar && steady, detail: `${avgRoe}% on average over ${roes.length} years, lowest ${minRoe}%` });
  }

  const losses = ys.filter((y) => y.netIncome! <= 0);
  checks.push({ id: "profitable", pass: losses.length === 0, detail: losses.length ? `a loss in ${losses.map((y) => y.end.slice(0, 4)).join(", ")}` : `${ys.length} of ${ys.length} years` });

  // Growth: the yearly rate between the first and last year on file (both have to be profits), and up on five years ago.
  const span = (Date.parse(last.end) - Date.parse(first.end)) / (365.25 * 86400_000);
  const growthPct = first.netIncome! > 0 && last.netIncome! > 0 && span >= 3 ? r1((Math.pow(last.netIncome! / first.netIncome!, 1 / span) - 1) * 100) : null;
  const five = ys[Math.max(0, ys.length - 6)];
  checks.push({ id: "growth", pass: growthPct === null ? (last.netIncome! > 0 && first.netIncome! <= 0 ? null : false) : growthPct >= LONG_TERM.growth && last.netIncome! > five.netIncome!, detail: growthPct === null ? "cannot be measured from a loss" : `${growthPct > 0 ? "+" : ""}${growthPct}% a year from ${first.end.slice(0, 4)} to ${last.end.slice(0, 4)}` });

  const debtYears = last.debt !== null && last.netIncome! > 0 ? r1(last.debt / last.netIncome!) : null;
  checks.push({ id: "debt", pass: special ? null : last.debt === null ? null : last.netIncome! > 0 && debtYears! <= LONG_TERM.debtYears, detail: special ? "not asked of this kind of business" : last.debt === null ? "long-term debt is not reported as one figure" : last.netIncome! <= 0 ? "no profit to pay it from" : `${debtYears} years of profit` });

  const cashYs = ys.filter((y) => y.cashFromOps !== null);
  const free = cashYs.map((y) => y.cashFromOps! - Math.abs(y.capex ?? 0));
  const profit = cashYs.reduce((a, y) => a + y.netIncome!, 0);
  const cashShare = cashYs.length >= LONG_TERM.minYears && profit > 0 ? Math.round((free.reduce((a, b) => a + b, 0) / profit) * 100) / 100 : null;
  const cashPos = cashYs.length ? free.filter((x) => x > 0).length / cashYs.length : 0;
  checks.push({ id: "cash", pass: special ? null : cashShare === null ? null : cashShare >= LONG_TERM.cashShare && cashPos >= LONG_TERM.cashYears, detail: special ? "not asked of this kind of business" : cashShare === null ? "cash flow is not reported for enough years" : `free cash was ${Math.round(cashShare * 100)}% of profit; positive in ${free.filter((x) => x > 0).length} of ${cashYs.length} years` });

  const margins = ys.filter((y) => y.revenue && y.revenue > 0).map((y) => (y.netIncome! / y.revenue!) * 100).filter((m) => m <= 100 && m >= -500);
  const avgMargin = margins.length >= LONG_TERM.minYears ? r1(mean(margins)) : null;
  checks.push({ id: "margin", pass: special ? null : avgMargin === null ? null : avgMargin >= LONG_TERM.margin, detail: special ? "not asked of this kind of business" : avgMargin === null ? "sales are not reported for enough years" : `${avgMargin}% of sales on average` });

  const sh = splitFreeShares(ys.map((y) => y.shares));
  const lastSh = sh[sh.length - 1], fiveSh = sh[Math.max(0, sh.length - 6)];
  const sharesPct5y = lastSh && fiveSh ? r1((lastSh / fiveSh - 1) * 100) : null;
  checks.push({ id: "dilution", pass: sharesPct5y === null ? null : sharesPct5y <= LONG_TERM.dilution, detail: sharesPct5y === null ? "the share count is not reported for enough years" : sharesPct5y <= -1 ? `share count down ${Math.abs(sharesPct5y)}% in five years (buying itself back)` : `share count ${sharesPct5y >= 0 ? "up" : "down"} ${Math.abs(sharesPct5y)}% in five years` });

  const lastFree = last.cashFromOps !== null ? last.cashFromOps - Math.abs(last.capex ?? 0) : null;
  return { metrics: { years: ys.length, firstYear: first.end, lastYear: last.end, avgRoe, minRoe, growthPct, debtYears, cashShare, avgMargin, sharesPct5y, netIncome: last.netIncome!, freeCash: lastFree, shares: last.shares, currency }, checks };
}

export type Verdict = "passes" | "one short" | "no";
/** Pure: passes every check that could be made (at least four), misses one, or misses more. */
export function verdictOf(checks: Check[]): { verdict: Verdict; passed: number; asked: number } {
  const asked = checks.filter((c) => c.pass !== null), passed = asked.filter((c) => c.pass).length;
  return { verdict: asked.length >= 4 && passed === asked.length ? "passes" : asked.length >= 4 && passed === asked.length - 1 ? "one short" : "no", passed, asked: asked.length };
}

export type PriceTag = "fair" | "full" | "expensive" | "unknown";
/**
 * Pure: the price against last year's profit. Market value is the price times the year's average diluted share
 * count; a ratio under 2 or over 150 is treated as a data problem (a split since the year end), not a price.
 */
export function priceOf(m: Pick<Metrics, "netIncome" | "freeCash" | "shares" | "currency">, price: number | null): { pe: number | null; earningsYieldPct: number | null; freeCashYieldPct: number | null; tag: PriceTag } {
  if (!price || !m.shares || m.netIncome <= 0 || (m.currency && m.currency !== "USD")) return { pe: null, earningsYieldPct: null, freeCashYieldPct: null, tag: "unknown" };
  const cap = price * m.shares, pe = cap / m.netIncome;
  if (pe < 2 || pe > 150) return { pe: null, earningsYieldPct: null, freeCashYieldPct: null, tag: "unknown" };
  return { pe: r1(pe), earningsYieldPct: r1(100 / pe), freeCashYieldPct: m.freeCash !== null ? r1((m.freeCash / cap) * 100) : null, tag: pe <= LONG_TERM.fairPe ? "fair" : pe <= LONG_TERM.richPe ? "full" : "expensive" };
}

export interface LongTermRow { symbol: string; sector: Sector | null; name: string | null; /** Place on the SEC's size-ordered list (1 is the largest). */ rank: number | null; computedAt: string; metrics: Metrics | null; checks: Check[]; passed: number; asked: number; verdict: Verdict; error: string | null }

const SECTOR_OF = new Map<string, Sector>(Object.entries(UNIVERSE).flatMap(([s, syms]) => syms.map((x) => [x, s as Sector] as [string, Sector])));
const FUNDS = new Set<string>(Object.values(SECTORS));

const BANK_OR_INSURER = ["InterestAndDividendIncomeOperating", "InterestExpenseDeposits", "ProvisionForLoanAndLeaseLosses", "ProvisionForLoanLeaseAndOtherLosses", "PremiumsEarnedNet", "PolicyholderBenefitsAndClaimsIncurredNet", "Deposits", "LoansAndLeasesReceivableNetReportedAmount"];
const PROPERTY_TRUST = ["RealEstateInvestmentPropertyNet", "RealEstateInvestmentPropertyAtCost", "RealEstateInvestmentPropertyAccumulatedDepreciation"];
/**
 * Pure: is this a bank, an insurer or a property trust, from what it reports? (A company outside the scout's own
 * sector list has no sector on file; these are the kinds whose debt, cash flow and margin mean something else.)
 */
export function kindFromFacts(facts: Facts): Sector | null {
  const has = (names: string[]) => names.filter((n) => Object.keys(facts["us-gaap"]?.[n]?.units ?? {}).length > 0).length;
  if (has(BANK_OR_INSURER) >= 2) return "financials";
  if (has(PROPERTY_TRUST) >= 1) return "real_estate";
  return null;
}

export interface Listed { symbol: string; cik: string; name: string; rank: number }

/**
 * Pure: the companies to screen from the SEC's list (largest first): one entry per company (a second share class
 * such as GOOG beside GOOGL is the same company), plain symbols only, and no sector funds.
 */
export function largestCompanies(list: Array<{ cik: string; ticker: string; title: string }>, size = LONG_TERM.size): Listed[] {
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

/** The list being screened, kept for a week (the SEC's file is about a megabyte). */
export async function longTermUniverse(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<Listed[]> {
  const hit = await store.cacheGet<Listed[]>("longterm:universe").catch(() => null);
  if (hit?.data?.length && Date.now() - Date.parse(hit.updatedAt) < 7 * 86400_000) return hit.data;
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return hit?.data ?? [];
  const { secTickerList } = await import("../sources/edgar");
  const list = largestCompanies(await secTickerList(ua, fetchImpl));
  if (list.length) await store.cachePut("longterm:universe", list).catch(() => undefined);
  return list.length ? list : hit?.data ?? [];
}

/** A listed name as people write it ("APPLE INC" → "Apple Inc"). */
const nice = (t: string) => (t === t.toUpperCase() ? t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t);

const toRow = (r: Record<string, unknown>): LongTermRow => {
  const checks = (r.checks as Check[]) ?? [];
  const v = verdictOf(checks);
  return { symbol: String(r.symbol), sector: (r.sector as Sector) ?? null, name: (r.name as string) ?? null, rank: r.rank === null || r.rank === undefined ? null : Number(r.rank), computedAt: new Date(r.computed_at as string).toISOString(), metrics: (r.metrics as Metrics) ?? null, checks, passed: v.passed, asked: v.asked, verdict: r.metrics ? v.verdict : "no", error: (r.error as string) ?? null };
};

/** The companies screened under the current checks (rows from an older set of checks are not shown while they wait to be redone). */
export async function longTermRows(): Promise<LongTermRow[]> {
  return (await q(`SELECT * FROM long_term WHERE rev = $1 ORDER BY symbol`, [LONG_TERM.rev])).map(toRow);
}

/**
 * One pass (its own job): the largest companies not screened in the last 30 days, biggest first, until the pass's
 * time is up. The whole list takes about a day of passes the first time; then each company is screened again
 * monthly (a new annual report changes it).
 */
export async function runLongTerm(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, max = LONG_TERM.perRun): Promise<string> {
  if (!env.SEC_USER_AGENT?.trim()) return "long term: SEC_USER_AGENT is not set";
  const universe = await longTermUniverse(env, fetchImpl === fetch ? undefined : fetchImpl);
  if (!universe.length) return "long term: the SEC's company list could not be read";
  // A row from an older set of checks counts as never screened.
  const done = new Map((await q(`SELECT symbol, computed_at, rev FROM long_term`)).map((r) => [String(r.symbol), Number(r.rev ?? 0) === LONG_TERM.rev ? Date.parse(r.computed_at as string) : 0]));
  const stale = Date.now() - LONG_TERM.refreshDays * 86400_000;
  const due = universe.filter((c) => (done.get(c.symbol) ?? 0) < stale).sort((a, b) => (done.get(a.symbol) ?? 0) - (done.get(b.symbol) ?? 0) || a.rank - b.rank).slice(0, max);
  if (!due.length) return `long term: all ${universe.length} companies screened in the last ${LONG_TERM.refreshDays} days`;
  const { secFactsByCik } = await import("../sources/fmp");
  const started = Date.now();
  let ok = 0, read = 0;
  const passed: string[] = [], seen: string[] = [];
  for (const c of due) {
    if (Date.now() - started > LONG_TERM.runSeconds * 1000) break;
    let sector = SECTOR_OF.get(c.symbol) ?? null;
    let metrics: Metrics | null = null, checks: Check[] = [], error: string | null = null;
    try {
      const facts = await secFactsByCik(c.cik, env, fetchImpl);
      if (facts === "no-company") error = "no annual reports found at the SEC for this company";
      else if (!facts) throw new Error("the SEC did not answer");
      else {
        sector ??= kindFromFacts(facts);
        const r = longTermChecks(fiscalYears(facts), sector, reportingCurrency(facts));
        if (!r) error = `fewer than ${LONG_TERM.minYears} fiscal years of net income on file`;
        else {
          metrics = r.metrics; checks = r.checks; ok++;
          const v = verdictOf(checks);
          if (v.verdict === "passes") passed.push(c.symbol);
          // A compact reading for the first few of a pass, so the numbers can be checked by eye in the log.
          if (seen.length < 12) seen.push(`${c.symbol} #${c.rank} ${v.passed}/${v.asked} (return ${metrics.avgRoe ?? "?"}%, growth ${metrics.growthPct ?? "?"}%, debt ${metrics.debtYears ?? "?"}y, margin ${metrics.avgMargin ?? "?"}%, shares ${metrics.sharesPct5y ?? "?"}%, ${metrics.years}y)`);
        }
      }
    } catch (e) {
      // Not recorded: the company is tried again on a later pass.
      console.warn(`long term ${c.symbol}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      continue;
    }
    read++;
    await q(
      `INSERT INTO long_term (symbol, sector, name, computed_at, metrics, checks, error, rev, cik, rank) VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)
       ON CONFLICT (symbol) DO UPDATE SET sector = EXCLUDED.sector, name = EXCLUDED.name, computed_at = now(), metrics = EXCLUDED.metrics, checks = EXCLUDED.checks, error = EXCLUDED.error, rev = EXCLUDED.rev, cik = EXCLUDED.cik, rank = EXCLUDED.rank`,
      [c.symbol, sector, nice(c.name), metrics ? JSON.stringify(metrics) : null, JSON.stringify(checks), error, LONG_TERM.rev, c.cik, c.rank],
    );
  }
  const total = Number((await q(`SELECT count(*) AS n FROM long_term WHERE rev = $1`, [LONG_TERM.rev]))[0]?.n ?? 0);
  return `long term: ${read} companies read, ${ok} with enough history${passed.length ? `, passing every check: ${passed.join(", ")}` : ""} · ${seen.join("; ")} · ${total} of ${universe.length} screened so far`;
}
