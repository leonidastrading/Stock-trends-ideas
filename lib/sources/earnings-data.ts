/**
 * Earnings data for the earnings-drift desk. Free, public sources:
 * - Nasdaq's earnings calendar (api.nasdaq.com/api/calendar/earnings?date=): per report the consensus EPS, the
 *   actual EPS once reported (past dates), timing (before open / after close), market cap, fiscal quarter end and
 *   the year-ago EPS. These are the street (adjusted) numbers on both sides, so they match.
 * - Nasdaq's stock summary (sector), for the reports that pass the numeric filters only.
 * - Finnhub (finnhub.io, FINNHUB_API_KEY, optional): consensus and actual revenue; asked again by symbol, then
 *   Financial Modeling Prep (FMP_API_KEY), for a possible setup the calendar call left out.
 * - SEC EDGAR: the earnings press release (8-K item 2.02 exhibit 99.1, or a foreign company's 6-K), for the AI step only.
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

/** One day's calendar. `fresh` skips the cache (the nightly scan must see the actuals, not an earlier copy). */
export async function calendarDay(date: string, fetchImpl?: typeof fetch, fresh = false): Promise<EarningsReport[]> {
  const j = JSON.parse(await getText(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: BROWSER, fetchImpl, cacheMs: fresh ? 0 : 30 * 60000, minIntervalMs: 400, timeoutMs: 15_000 }));
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

/** Revenue for one report, and where it came from. */
export interface RevenuePair { revenueActual: number | null; revenueEstimate: number | null; source: string }

/** Pure: the row for this report in one stock's earnings list (dates differ by a day between feeds: within 3 days). */
export function revenueRow(rows: unknown, reportDate: string, symbol?: string): Record<string, unknown> | null {
  if (!Array.isArray(rows)) return null;
  const t = Date.parse(`${reportDate}T00:00:00Z`);
  const near = (rows as Array<Record<string, unknown>>)
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}/.test(String(r.date ?? "")) && (!symbol || !r.symbol || String(r.symbol).toUpperCase() === symbol))
    .map((r) => ({ r, gap: Math.abs(Date.parse(`${String(r.date).slice(0, 10)}T00:00:00Z`) - t) / 86400_000 }))
    .filter((x) => x.gap <= 3).sort((a, b) => a.gap - b.gap);
  return near[0]?.r ?? null;
}

/** Pure: revenue from a feed's row (Finnhub: revenueActual/revenueEstimate; FMP: revenueActual or revenue, revenueEstimated). */
export function revenueOf(row: Record<string, unknown> | null, source: string): RevenuePair | null {
  if (!row) return null;
  const pos = (v: unknown) => { const n = money(v); return n !== null && n > 0 ? n : null; };
  const out = { revenueActual: pos(row.revenueActual ?? row.revenue), revenueEstimate: pos(row.revenueEstimate ?? row.revenueEstimated), source };
  return out.revenueActual === null && out.revenueEstimate === null ? null : out;
}

/** One stock's report from Finnhub's calendar (asked by symbol: the date-range call leaves many companies out). */
export async function finnhubRevenueFor(symbol: string, reportDate: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<RevenuePair | null> {
  const key = env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  const day = (n: number) => new Date(Date.parse(`${reportDate}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const res = await fetchImpl(`https://finnhub.io/api/v1/calendar/earnings?${new URLSearchParams({ from: day(-4), to: day(4), symbol })}`, { headers: { "X-Finnhub-Token": key, accept: "application/json" } });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  return revenueOf(revenueRow(((await res.json()) as { earningsCalendar?: unknown }).earningsCalendar, reportDate, symbol), "Finnhub");
}

/** One stock's report from Financial Modeling Prep (FMP_API_KEY; its free plan covers only some stocks). */
export async function fmpRevenueFor(symbol: string, reportDate: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<RevenuePair | null> {
  const key = env.FMP_API_KEY?.trim();
  if (!key) return null;
  const s = encodeURIComponent(symbol);
  for (const path of [`/stable/earnings?symbol=${s}&limit=8`, `/api/v3/historical/earning_calendar/${s}?limit=8`]) {
    const res = await fetchImpl(`https://financialmodelingprep.com${path}&apikey=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res?.ok) continue;
    const got = revenueOf(revenueRow(await res.json().catch(() => null), reportDate, symbol), "Financial Modeling Prep");
    if (got) return got;
  }
  return null;
}

/** Pure: the first source's numbers, with the gaps filled from the next (and both named when both were used). */
export function mergeRevenue(pairs: Array<RevenuePair | null>): RevenuePair | null {
  let out: RevenuePair | null = null;
  for (const p of pairs) {
    if (!p) continue;
    if (!out) { out = { ...p }; continue; }
    const before = `${out.revenueActual}|${out.revenueEstimate}`;
    out.revenueActual ??= p.revenueActual; out.revenueEstimate ??= p.revenueEstimate;
    if (`${out.revenueActual}|${out.revenueEstimate}` !== before) out.source = `${out.source} + ${p.source}`;
  }
  return out;
}

/** Revenue for one report when the nightly calendar call had none: Finnhub by symbol, then Financial Modeling Prep. Never throws. */
export async function revenueFallback(symbol: string, reportDate: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<RevenuePair | null> {
  const a = await finnhubRevenueFor(symbol, reportDate, env, fetchImpl).catch(() => null);
  if (a?.revenueActual != null && a.revenueEstimate != null) return a;
  const b = await fmpRevenueFor(symbol, reportDate, env, fetchImpl).catch(() => null);
  return mergeRevenue([a, b]);
}

/** Pure: the past report dates in Finnhub's calendar for one stock (up to today). */
export function finnhubDates(j: { earningsCalendar?: Array<Record<string, unknown>> }, symbol: string, today: string): string[] {
  return [...new Set((j.earningsCalendar ?? []).filter((r) => String(r.symbol).toUpperCase() === symbol && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) && String(r.date) <= today).map((r) => String(r.date)))].sort();
}

/**
 * One stock's report dates from Finnhub's earnings calendar. The chart's second source: foreign companies (AS, PDD,
 * HTHT) report on form 6-K, not the 8-K item 2.02 the SEC source reads, so they had no earnings lines. Null without a key.
 */
export async function finnhubEarningsDates(symbol: string, from: string, today: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const key = env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  const res = await fetchImpl(`https://finnhub.io/api/v1/calendar/earnings?${new URLSearchParams({ from, to: today, symbol })}`, { headers: { "X-Finnhub-Token": key, accept: "application/json" } });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  return finnhubDates((await res.json()) as { earningsCalendar?: Array<Record<string, unknown>> }, symbol, today);
}

/**
 * Pure: report dates from several sources as one list. Sources date the same report a day or two apart (the SEC by
 * the day the 8-K was filed, a calendar by the day it expects the report, after-the-close reports by the next day), so
 * a date within a few days of one already kept is the same report: the first source to name it wins.
 */
export function mergeReportDates(lists: string[][], withinDays = 4): string[] {
  const out: string[] = [];
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
  for (const list of lists) for (const d of [...list].sort()) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !out.some((x) => Math.abs(t(x) - t(d)) <= withinDays * 86400_000)) out.push(d);
  return out.sort();
}

// ---------------------------------------------------------------- the press release (SEC 8-K item 2.02, or a foreign company's 6-K)

/** Pure: text that reads like an earnings release (a quarter or period named, and results in numbers). */
export const looksLikeResults = (text: string) => /\b(quarter|three months|six months|nine months|half[- ]year|fiscal (year|20\d\d)|full[- ]year)\b/i.test(text) && /\b(revenues?|net (income|loss|sales)|earnings per|operating (profit|income|loss))\b/i.test(text);

/** Pure: the filings that can carry the earnings release, best first: the 8-K with item 2.02, then 6-Ks (foreign companies), nearest the report. */
export function releaseFilings(r: { form: string[]; filingDate: string[]; accessionNumber: string[]; items?: string[] }, reportDate: string): Array<{ accession: string; form: string }> {
  const at = (n: number) => new Date(Date.parse(`${reportDate}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const lo = at(-2), hi = at(3);
  const inWindow = r.form.map((form, k) => ({ form, k, date: r.filingDate[k] })).filter((x) => x.date >= lo && x.date <= hi);
  const k8 = inWindow.filter((x) => x.form.startsWith("8-K") && (r.items?.[x.k] ?? "").includes("2.02"));
  const gap = (d: string) => Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${reportDate}T00:00:00Z`));
  const k6 = inWindow.filter((x) => x.form === "6-K").sort((a, b) => gap(a.date) - gap(b.date)).slice(0, 4);
  return [...k8.slice(0, 1), ...k6].map((x) => ({ accession: r.accessionNumber[x.k], form: x.form }));
}

/**
 * The earnings press release text: the 8-K (item 2.02) filed around the report, or for a foreign company (PDD, AS,
 * HTHT file 6-Ks) the 6-K whose exhibit reads like results. Null when not found. Best effort.
 */
export async function pressRelease(symbol: string, reportDate: string, ua: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ text: string; url: string } | null> {
  if (!ua) return null;
  const h = { "user-agent": ua, accept: "application/json, text/html, */*" };
  const tickers = JSON.parse(await getText("https://www.sec.gov/files/company_tickers.json", { headers: h, fetchImpl, cacheMs: 24 * 3600_000, minIntervalMs: 130 })) as Record<string, { cik_str: number; ticker: string }>;
  const cik = Object.values(tickers).find((t) => t.ticker === symbol)?.cik_str;
  if (!cik) return null;
  const sub = JSON.parse(await getText(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, { headers: h, fetchImpl, cacheMs: 3600_000, minIntervalMs: 130 })) as { filings?: { recent?: { form: string[]; filingDate: string[]; accessionNumber: string[]; items?: string[] } } };
  const r = sub.filings?.recent;
  if (!r) return null;
  const { htmlText } = await import("./site");
  for (const f of releaseFilings(r, reportDate)) {
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accession.replace(/-/g, "")}`;
    const idx = JSON.parse(await getText(`${base}/index.json`, { headers: h, fetchImpl, cacheMs: 3600_000, minIntervalMs: 130 })) as { directory?: { item?: Array<{ name: string }> } };
    const names = (idx.directory?.item ?? []).map((x) => x.name).filter((n) => /\.htm/i.test(n) && !/index/i.test(n));
    // The exhibit 99 when it is named so; a 6-K's release is sometimes its only document.
    const files = [...names.filter((n) => /ex-?99|exhibit-?99|ex99|dex99/i.test(n)), ...(f.form === "6-K" ? names.filter((n) => !/ex-?99|exhibit-?99|ex99|dex99/i.test(n)) : [])].slice(0, 3);
    for (const file of files) {
      const html = await getText(`${base}/${file}`, { headers: { ...h, accept: "text/html" }, fetchImpl, cacheMs: 3600_000, minIntervalMs: 130, timeoutMs: 15_000 }).catch(() => "");
      const text = htmlText(html);
      // An 8-K item 2.02 exhibit is the release by definition; a 6-K can be anything, so it has to read like results.
      // A 6-K's short cover page can name the quarter too: only a document of some length counts when it is not the exhibit.
      const longEnough = text.length > (/ex-?99|exhibit-?99|ex99|dex99/i.test(file) ? 400 : 3000);
      if (longEnough && (f.form !== "6-K" || looksLikeResults(text.slice(0, 6000)))) return { text: text.slice(0, 15_000), url: `${base}/${file}` };
    }
  }
  return null;
}
