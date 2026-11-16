/**
 * Earnings data for the earnings-drift desk. Free, public sources:
 * - Nasdaq's earnings calendar (api.nasdaq.com/api/calendar/earnings?date=): per report the consensus EPS, the
 *   actual EPS once reported (past dates), timing (before open / after close), market cap, fiscal quarter end and
 *   the year-ago EPS. These are the street (adjusted) numbers on both sides, so they match.
 * - Nasdaq's stock summary (sector), for the reports that pass the numeric filters only.
 * - Finnhub (finnhub.io, FINNHUB_API_KEY, optional): consensus and actual revenue. Without it, revenue is "unknown".
 * - SEC EDGAR: the earnings press release (8-K item 2.02, exhibit 99.1), for the AI step only.
 * Parsers are pure; a missing field stays null and is reported as missing, never guessed.
 */
import { getText } from "../http";

const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "application/json, text/plain, */*" };

export type Timing = "before_open" | "after_close" | "unknown";

export interface EarningsReport {
  symbol: string; name: string; reportDate: string; timing: Timing;
  epsActual: number | null; epsEstimate: number | null; marketCap: number | null;
  /** YYYY-MM-DD, the last day of the fiscal quarter ("Sep/2026" → 2026-09-30). */
  quarterEnd: string | null;
  lastYearEps: number | null; estimates: number | null;
  revenueActual?: number | null; revenueEstimate?: number | null;
}

/** "$1.23", "($0.45)", "-0.45", "N/A" → number or null. */
export const money = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || /^(n\/?a|--?|—)$/i.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[()$,\s-]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Sep/2026" → "2026-09-30". */
export function quarterEndOf(s: unknown): string | null {
  const m = typeof s === "string" ? /^([A-Za-z]{3})\/(\d{4})$/.exec(s.trim()) : null;
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  const y = Number(m[2]), mo = MONTHS[m[1].toLowerCase()];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/** Pure: one day of Nasdaq's earnings calendar, every field the desk uses. */
export function parseCalendarDay(json: unknown, date: string): EarningsReport[] {
  const rows = (json as { data?: { rows?: Array<Record<string, unknown>> | null } })?.data?.rows ?? [];
  return rows.map((r) => {
    const time = String(r.time ?? "");
    return {
      symbol: String(r.symbol ?? "").trim().toUpperCase(), name: String(r.name ?? ""), reportDate: date,
      timing: (/pre-market|before/i.test(time) ? "before_open" : /after-hours|after/i.test(time) ? "after_close" : "unknown") as Timing,
      epsActual: money(r.eps ?? r.epsActual), epsEstimate: money(r.epsForecast ?? r.epsEstimate),
      marketCap: money(r.marketCap), quarterEnd: quarterEndOf(r.fiscalQuarterEnding),
      lastYearEps: money(r.lastYearEPS), estimates: money(r.noOfEsts),
    };
  }).filter((r) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(r.symbol));
}

export async function calendarDay(date: string, fetchImpl?: typeof fetch): Promise<EarningsReport[]> {
  const j = JSON.parse(await getText(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: BROWSER, fetchImpl, cacheMs: 30 * 60000, minIntervalMs: 400, timeoutMs: 15_000 }));
  return parseCalendarDay(j, date);
}

// ---------------------------------------------------------------- sector

/** Nasdaq's sectors the research excludes (its Consumer Defensive, Utilities, Communication Services and Real Estate). */
export const DEFENSIVE = /consumer staples|consumer defensive|utilities|telecommunications|communication services|real estate/i;

/** Pure: the sector from Nasdaq's stock summary. */
export function parseSector(json: unknown): string | null {
  const s = (json as { data?: { summaryData?: Record<string, { value?: string }> } })?.data?.summaryData;
  const v = s?.Sector?.value ?? s?.sector?.value ?? null;
  return v && v !== "N/A" ? v : null;
}

export async function sectorOf(symbol: string, fetchImpl?: typeof fetch): Promise<string | null> {
  const j = JSON.parse(await getText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetClass=stocks`, { headers: BROWSER, fetchImpl, cacheMs: 24 * 3600_000, minIntervalMs: 400, timeoutMs: 12_000 }));
  return parseSector(j);
}

// ---------------------------------------------------------------- revenue (Finnhub, optional)

/** Pure: Finnhub's earnings calendar → revenue (and its EPS, for a cross-check) by symbol and date. */
export function parseFinnhub(j: { earningsCalendar?: Array<Record<string, unknown>> }): Map<string, { revenueActual: number | null; revenueEstimate: number | null; hour: string }> {
  const out = new Map<string, { revenueActual: number | null; revenueEstimate: number | null; hour: string }>();
  for (const r of j.earningsCalendar ?? []) out.set(`${String(r.symbol)}|${String(r.date)}`, { revenueActual: money(r.revenueActual), revenueEstimate: money(r.revenueEstimate), hour: String(r.hour ?? "") });
  return out;
}

export async function finnhubRevenue(from: string, to: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const key = env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  const res = await fetchImpl(`https://finnhub.io/api/v1/calendar/earnings?${new URLSearchParams({ from, to })}`, { headers: { "X-Finnhub-Token": key, accept: "application/json" } });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  return parseFinnhub((await res.json()) as { earningsCalendar?: Array<Record<string, unknown>> });
}

// ---------------------------------------------------------------- the press release (SEC 8-K item 2.02)

/** The earnings press release text, from the 8-K (item 2.02) filed around the report; null when not found. Best effort. */
export async function pressRelease(symbol: string, reportDate: string, ua: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ text: string; url: string } | null> {
  if (!ua) return null;
  const h = { "user-agent": ua, accept: "application/json, text/html, */*" };
  const tickers = JSON.parse(await getText("https://www.sec.gov/files/company_tickers.json", { headers: h, fetchImpl, cacheMs: 24 * 3600_000, minIntervalMs: 130 })) as Record<string, { cik_str: number; ticker: string }>;
  const cik = Object.values(tickers).find((t) => t.ticker === symbol)?.cik_str;
  if (!cik) return null;
  const sub = JSON.parse(await getText(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, { headers: h, fetchImpl, cacheMs: 3600_000, minIntervalMs: 130 })) as { filings?: { recent?: { form: string[]; filingDate: string[]; accessionNumber: string[]; items?: string[] } } };
  const r = sub.filings?.recent;
  if (!r) return null;
  const lo = new Date(Date.parse(`${reportDate}T00:00:00Z`) - 2 * 86400_000).toISOString().slice(0, 10);
  const hi = new Date(Date.parse(`${reportDate}T00:00:00Z`) + 3 * 86400_000).toISOString().slice(0, 10);
  const i = r.form.findIndex((f, k) => f.startsWith("8-K") && r.filingDate[k] >= lo && r.filingDate[k] <= hi && (r.items?.[k] ?? "").includes("2.02"));
  if (i < 0) return null;
  const acc = r.accessionNumber[i];
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}`;
  const idx = JSON.parse(await getText(`${base}/index.json`, { headers: h, fetchImpl, cacheMs: 3600_000, minIntervalMs: 130 })) as { directory?: { item?: Array<{ name: string }> } };
  const file = (idx.directory?.item ?? []).map((x) => x.name).find((n) => /ex-?99|exhibit-?99|ex99/i.test(n) && /\.htm/i.test(n));
  if (!file) return null;
  const { htmlText } = await import("./site");
  const html = await getText(`${base}/${file}`, { headers: { ...h, accept: "text/html" }, fetchImpl, cacheMs: 3600_000, minIntervalMs: 130, timeoutMs: 15_000 });
  return { text: htmlText(html).slice(0, 15_000), url: `${base}/${file}` };
}
