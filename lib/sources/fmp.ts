/**
 * Financial Modeling Prep (FMP_API_KEY): a company's income statement (revenue, net income, net margin; annual or
 * quarterly) and its earnings per share against the estimate (with the next quarter's estimate), for the cards.
 * Cached a day per stock (the free plan allows about 250 calls a day). The stable API first, then the older v3 one.
 */
import * as store from "../scout/store";

const HOST = "https://financialmodelingprep.com";

export interface IncomeRow { label: string; date: string; revenue: number | null; netIncome: number | null; margin: number | null }
export interface EpsRow { label: string; date: string; actual: number | null; estimate: number | null }
export interface Fundamentals { symbol: string; period: "annual" | "quarter"; income: IncomeRow[]; eps: EpsRow[]; error: string | null }

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

async function get(path: string, key: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(`${HOST}${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`FMP ${res.status}${body && typeof body === "object" && "Error Message" in body ? `: ${String((body as Record<string, unknown>)["Error Message"]).slice(0, 120)}` : ""}`);
  if (body && typeof body === "object" && !Array.isArray(body) && "Error Message" in body) throw new Error(String((body as Record<string, unknown>)["Error Message"]).slice(0, 160));
  return body;
}

/** The income statement and EPS history for one stock, cached a day. Errors are returned, not thrown. */
export async function fundamentals(symbol: string, period: "annual" | "quarter", today: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Fundamentals> {
  const key = env.FMP_API_KEY?.trim();
  if (!key) return { symbol, period, income: [], eps: [], error: "FMP_API_KEY is not set" };
  const cacheKey = `fmp:${symbol}:${period}`;
  const hit = await store.cacheGet<Fundamentals>(cacheKey).catch(() => null);
  if (hit && Date.now() - Date.parse(hit.updatedAt) < 24 * 3600_000 && !hit.data.error) return hit.data;
  const s = encodeURIComponent(symbol);
  const errors: string[] = [];
  const tryAll = async (paths: string[]) => { for (const p of paths) { try { const b = await get(p, key, fetchImpl); if (Array.isArray(b) && b.length) return b; } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); } } return null; };
  const [inc, earn] = await Promise.all([
    tryAll([`/stable/income-statement?symbol=${s}&period=${period}&limit=5`, `/api/v3/income-statement/${s}?period=${period}&limit=5`]),
    tryAll([`/stable/earnings?symbol=${s}&limit=12`, `/api/v3/historical/earning_calendar/${s}?limit=12`]),
  ]);
  const out: Fundamentals = { symbol, period, income: parseIncome(inc, period), eps: parseEarnings(earn, today), error: !inc && !earn ? (errors[0] ?? "no data from FMP") : null };
  if (!out.error) await store.cachePut(cacheKey, out).catch(() => undefined);
  return out;
}
