/**
 * Financial Modeling Prep (FMP_API_KEY): a company's income statement (revenue, net income, net margin; annual or
 * quarterly) and its earnings per share against the estimate (with the next quarter's estimate), for the cards.
 * Cached a day per stock (the free plan allows about 250 calls a day). The stable API first, then the older v3 one.
 */
import * as store from "../scout/store";

const HOST = "https://financialmodelingprep.com";

export interface IncomeRow { label: string; date: string; revenue: number | null; netIncome: number | null; margin: number | null }
export interface EpsRow { label: string; date: string; actual: number | null; estimate: number | null }
export interface Fundamentals { symbol: string; period: "annual" | "quarter"; income: IncomeRow[]; eps: EpsRow[]; error: string | null; incomeSource?: string; epsSource?: string; currency?: string | null }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Pure: "'25" for a fiscal year, "Q3 '26" for a quarter. */
export function periodLabel(r: Record<string, unknown>, period: "annual" | "quarter"): string {
  const date = String(r.date ?? r.fiscalDateEnding ?? "");
  const fy = String(r.fiscalYear ?? r.calendarYear ?? date.slice(0, 4));
  const yy = `'${fy.slice(-2)}`;
  if (period === "annual") return yy;
  const p = String(r.period ?? "");
  return /^Q[1-4]$/.test(p) ? `${p} ${yy}` : `Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1} '${date.slice(2, 4)}`;
}

/** Pure: income-statement rows, oldest first, with net margin in percent. */
export function parseIncome(rows: unknown, period: "annual" | "quarter", limit = 5): IncomeRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map((r: Record<string, unknown>) => {
    const revenue = num(r.revenue), netIncome = num(r.netIncome);
    return { label: periodLabel(r, period), date: String(r.date ?? ""), revenue, netIncome, margin: revenue && netIncome !== null ? Math.round((netIncome / revenue) * 1000) / 10 : null };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/** Pure: the last `past` reported quarters (actual and estimate) and the next one (estimate only), oldest first. */
export function parseEarnings(rows: unknown, today: string, past = 4): EpsRow[] {
  if (!Array.isArray(rows)) return [];
  const all = rows.map((r: Record<string, unknown>) => ({ date: String(r.date ?? ""), actual: num(r.epsActual ?? r.eps), estimate: num(r.epsEstimated ?? r.epsEstimate) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.date)).sort((a, b) => a.date.localeCompare(b.date));
  const done = all.filter((r) => r.date <= today && r.actual !== null).slice(-past);
  const next = all.find((r) => r.date > today && r.estimate !== null);
  const q = (d: string) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1} '${d.slice(2, 4)}`;
  return [...done, ...(next ? [{ ...next, actual: null }] : [])].map((r) => ({ label: q(r.date), ...r }));
}

// ------------------------------------------------- free fallbacks: the SEC's XBRL facts and Finnhub's EPS history

type Fact = { start?: string; end: string; val: number; form?: string; fp?: string; filed?: string };
const REVENUE = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "Revenue"];
const NET_INCOME = ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"];

/** Pure: one concept's facts (US GAAP or IFRS, any currency): the series with the latest data, and its unit. */
export function pickFacts(facts: Record<string, Record<string, { units?: Record<string, Fact[]> }>>, names: string[]): { unit: string; rows: Fact[] } | null {
  let best: { unit: string; rows: Fact[] } | null = null;
  for (const tax of ["us-gaap", "ifrs-full"]) for (const n of names) {
    const units = facts[tax]?.[n]?.units ?? {};
    for (const [unit, rows] of Object.entries(units)) {
      if (!Array.isArray(rows) || !rows.length || unit.includes("/")) continue;
      const last = rows.reduce((m, r) => (r.end > m ? r.end : m), "");
      if (!best || last > best.rows.reduce((m, r) => (r.end > m ? r.end : m), "")) best = { unit, rows };
    }
  }
  return best;
}

/** Pure: the last `n` periods of a fact: full years (about 12 months) or quarters (about 3 months), latest filing per period end. */
export function periodFacts(rows: Fact[], period: "annual" | "quarter", n = 5): Fact[] {
  const days = (r: Fact) => (r.start ? (Date.parse(r.end) - Date.parse(r.start)) / 86400_000 : NaN);
  const keep = rows.filter((r) => (period === "annual" ? days(r) > 330 && days(r) < 400 : days(r) > 80 && days(r) < 100));
  const byEnd = new Map<string, Fact>();
  for (const r of keep) { const prev = byEnd.get(r.end); if (!prev || (r.filed ?? "") > (prev.filed ?? "")) byEnd.set(r.end, r); }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-n);
}

/** Pure: revenue and net income facts into chart rows (matched by period end). */
export function secIncome(facts: Record<string, Record<string, { units?: Record<string, Fact[]> }>>, period: "annual" | "quarter"): { rows: IncomeRow[]; currency: string | null } {
  const rev = pickFacts(facts, REVENUE), ni = pickFacts(facts, NET_INCOME);
  if (!rev && !ni) return { rows: [], currency: null };
  const r = rev ? periodFacts(rev.rows, period) : [], nRows = ni ? periodFacts(ni.rows, period, 12) : [];
  const base = r.length ? r : periodFacts(ni!.rows, period);
  const rows = base.map((x) => {
    const revenue = rev ? r.find((y) => y.end === x.end)?.val ?? null : null;
    const netIncome = nRows.find((y) => y.end === x.end)?.val ?? null;
    const q = `Q${Math.floor((Number(x.end.slice(5, 7)) - 1) / 3) + 1} '${x.end.slice(2, 4)}`;
    return { label: period === "annual" ? `'${x.end.slice(2, 4)}` : q, date: x.end, revenue, netIncome, margin: revenue && netIncome !== null ? Math.round((netIncome / revenue) * 1000) / 10 : null };
  });
  return { rows, currency: (rev ?? ni)!.unit };
}

/** Pure: Finnhub's last reported quarters (actual and estimate) and the next estimate, oldest first. */
export function finnhubEps(hist: unknown, next: unknown, today: string): EpsRow[] {
  const q = (d: string) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1} '${d.slice(2, 4)}`;
  const past = (Array.isArray(hist) ? hist : []).map((r: Record<string, unknown>) => ({ date: String(r.period ?? ""), actual: num(r.actual), estimate: num(r.estimate) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.actual !== null).sort((a, b) => a.date.localeCompare(b.date)).slice(-4);
  const cal = (next as { earningsCalendar?: Array<Record<string, unknown>> } | null)?.earningsCalendar ?? [];
  const up = cal.map((r) => ({ date: String(r.date ?? ""), estimate: num(r.epsEstimate) })).filter((r) => r.date > today && r.estimate !== null).sort((a, b) => a.date.localeCompare(b.date))[0];
  return [...past.map((r) => ({ label: q(r.date), ...r })), ...(up ? [{ label: "next", date: up.date, actual: null, estimate: up.estimate }] : [])];
}

async function secFacts(symbol: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<Record<string, Record<string, { units?: Record<string, Fact[]> }>> | "no-company" | null> {
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return null;
  const { cikFor } = await import("./edgar");
  const headers = { "user-agent": ua, "accept-encoding": "gzip, deflate" };
  const cik = await cikFor(symbol, headers, fetchImpl).catch(() => null);
  if (!cik) return "no-company";
  const res = await fetchImpl(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10, "0")}.json`, { headers }).catch(() => null);
  if (!res || res.status === 404) return "no-company";
  if (!res.ok) return null;
  return ((await res.json().catch(() => null)) as { facts?: Record<string, Record<string, { units?: Record<string, Fact[]> }>> } | null)?.facts ?? null;
}

async function finnhub(path: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<unknown> {
  const key = env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  const res = await fetchImpl(`https://finnhub.io/api/v1${path}`, { headers: { "X-Finnhub-Token": key, accept: "application/json" } }).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}

async function get(path: string, key: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(`${HOST}${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`FMP ${res.status}${body && typeof body === "object" && "Error Message" in body ? `: ${String((body as Record<string, unknown>)["Error Message"]).slice(0, 120)}` : ""}`);
  if (body && typeof body === "object" && !Array.isArray(body) && "Error Message" in body) throw new Error(String((body as Record<string, unknown>)["Error Message"]).slice(0, 160));
  return body;
}

/** The income statement and EPS history for one stock, cached a day. Errors are returned, not thrown. */
export async function fundamentals(symbol: string, period: "annual" | "quarter", today: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Fundamentals> {
  const key = env.FMP_API_KEY?.trim() ?? "";
  const cacheKey = `fmp:${symbol}:${period}`;
  const hit = await store.cacheGet<Fundamentals>(cacheKey).catch(() => null);
  if (hit && Date.now() - Date.parse(hit.updatedAt) < 24 * 3600_000 && !hit.data.error) return hit.data;
  const s = encodeURIComponent(symbol);
  const errors: string[] = [];
  const tryAll = async (paths: string[]) => { for (const p of paths) { try { const b = await get(p, key, fetchImpl); if (Array.isArray(b) && b.length) return b; } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); } } return null; };
  const [inc, earn] = key ? await Promise.all([
    tryAll([`/stable/income-statement?symbol=${s}&period=${period}&limit=5`, `/api/v3/income-statement/${s}?period=${period}&limit=5`]),
    tryAll([`/stable/earnings?symbol=${s}&limit=12`, `/api/v3/historical/earning_calendar/${s}?limit=12`]),
  ]) : [null, null];
  let income = parseIncome(inc, period), eps = parseEarnings(earn, today), incomeSource = "Financial Modeling Prep", epsSource = "Financial Modeling Prep", currency: string | null = "USD";
  let fund = false;
  // FMP's free plan covers only some stocks (402 for the rest): the SEC's XBRL facts for the statements, Finnhub for EPS.
  if (!income.length) {
    const f = await secFacts(symbol, env, fetchImpl).catch(() => null);
    if (f === "no-company") fund = true;
    else if (f) { const r = secIncome(f, period); income = r.rows; currency = r.currency; incomeSource = "SEC filings (XBRL)"; if (!r.rows.length && !r.currency) fund = true; }
  }
  if (!eps.length) {
    const to = new Date(Date.parse(today) + 120 * 86400_000).toISOString().slice(0, 10);
    const [hist, next] = await Promise.all([finnhub(`/stock/earnings?symbol=${s}`, env, fetchImpl), finnhub(`/calendar/earnings?symbol=${s}&from=${today}&to=${to}`, env, fetchImpl)]);
    eps = finnhubEps(hist, next, today);
    epsSource = "Finnhub";
  }
  const error = income.length || eps.length ? null : fund ? "a fund or ETF: no income statement or earnings" : (errors[0] ?? "no data found");
  const out: Fundamentals = { symbol, period, income, eps, error, incomeSource, epsSource, currency };
  if (!out.error) await store.cachePut(cacheKey, out).catch(() => undefined);
  return out;
}
