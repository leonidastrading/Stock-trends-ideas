/**
 * Filing watch for the stocks on cards: is a quarterly (10-Q) or annual (10-K) report late, has the company filed a
 * late-filing notice (NT 10-Q / NT 10-K, Form 12b-25), or has it filed an 8-K that its past numbers can't be relied
 * on (item 4.02) or that its auditor changed (item 4.01)?
 *
 * Read from each company's SEC submissions list (data.sec.gov), every few hours per stock. Three kinds of "late":
 * - later than usual: earnings are out (8-K item 2.02) but the 10-Q isn't, and the company normally files it within N
 *   business days of earnings (NVIDIA, Nov 2026: same day for 12 quarters, then not);
 * - a late-filing notice is on file (the company says itself the report will be late);
 * - past the SEC deadline (40/45 days after the quarter, 60/75/90 after the year, by filer size).
 * Late filers, especially ones citing accounting reviews, tend to underperform (Alford, Jones & Zmijewski 1994;
 * Bartov, DeFond & Konchitchki), and a delay during a board investigation can come before a restatement.
 */
import { query as q } from "../db";
import { getJson } from "../http";
import { secTickerList } from "../sources/edgar";
import { addDays, daysBetween, toEt } from "../time";
import * as store from "./store";

export const FILING_WATCH = { everyHours: 6, maxSymbols: 80, recentCardDays: 14, seriousDays: 30 };

export interface FilingRow { form: string; filed: string; report: string | null; items: string[]; accession: string }
export type WatchStatus = "ok" | "late_vs_usual" | "nt_filed" | "past_due" | "red_flag";

export interface FilingStatus {
  status: WatchStatus;
  nextForm: "10-Q" | "10-K";
  /** Estimated end of the period the missing report covers (about 13 weeks after the last one). */
  periodEnd: string;
  dueBy: string;
  extendedTo: string | null;
  filerSize: string | null;
  earnings8k: string | null;
  /** Business days from earnings to the periodic report in past quarters (newest first). */
  usualLags: number[];
  nt: { form: string; filed: string; accession: string } | null;
  serious: Array<{ filed: string; items: string[]; accession: string }>;
  message: string;
}

const PERIODIC = new Set(["10-Q", "10-K"]);
const weekend = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
/** Pure: the date, moved to the next weekday if it falls on a weekend (the SEC rolls deadlines the same way). */
export const rollWeekend = (d: string) => { let x = d; while (weekend(x)) x = addDays(x, 1); return x; };

/** Pure: weekdays after `from` up to and including `to` (0 for the same day). */
export function businessDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (!weekend(d)) n++;
  return n;
}

/** Pure: days allowed after the period end, by the filer size the SEC lists for the company. */
export function deadlineDays(form: "10-Q" | "10-K", category: string | null): { days: number; size: string | null } {
  const c = (category ?? "").toLowerCase();
  if (c.includes("large accelerated")) return { days: form === "10-Q" ? 40 : 60, size: "large accelerated filer" };
  if (/(^|[^-])accelerated/.test(c) && !c.includes("non-accelerated")) return { days: form === "10-Q" ? 40 : 75, size: "accelerated filer" };
  return { days: form === "10-Q" ? 45 : 90, size: c.includes("non-accelerated") ? "non-accelerated filer" : null };
}

const SERIOUS: Record<string, string> = { "4.02": "past financial statements can no longer be relied on (4.02)", "4.01": "auditor change (4.01)" };
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Pure: the filing status from a company's submissions (any order). Null for companies that don't file 10-Qs (foreign filers, funds). */
export function assessFilings(symbol: string, rows: FilingRow[], category: string | null, today: string): FilingStatus | null {
  const all = rows.slice().sort((a, b) => b.filed.localeCompare(a.filed));
  const periodic = all.filter((r) => PERIODIC.has(r.form) && r.report);
  const last = periodic[0];
  if (!last || daysBetween(last.filed, today) > 400) return null;
  // The next report: a 10-K after three 10-Qs in a row, else a 10-Q.
  const nextForm: "10-Q" | "10-K" = periodic.slice(0, 3).length === 3 && periodic.slice(0, 3).every((r) => r.form === "10-Q") ? "10-K" : "10-Q";
  const periodEnd = addDays(last.report!, 91);
  const { days, size } = deadlineDays(nextForm, category);
  const dueBy = rollWeekend(addDays(periodEnd, days));
  const after = all.filter((r) => r.filed > last.filed);
  const ntRow = after.find((r) => r.form === `NT ${nextForm}`) ?? null;
  const extendedTo = ntRow ? rollWeekend(addDays(dueBy, nextForm === "10-Q" ? 5 : 15)) : null;
  const is202 = (r: FilingRow) => r.form.startsWith("8-K") && r.items.includes("2.02");
  const earnings = after.filter((r) => is202(r) && r.filed >= addDays(periodEnd, -7)).at(-1) ?? null;
  // How long after earnings the report usually comes (past quarters).
  const usualLags: number[] = [];
  for (const e of all.filter((r) => is202(r) && r.filed <= last.filed)) {
    const p = periodic.filter((r) => r.filed >= e.filed && daysBetween(e.filed, r.filed) <= 60).at(-1);
    if (p) usualLags.push(businessDaysBetween(e.filed, p.filed));
    if (usualLags.length >= 8) break;
  }
  const serious = all.filter((r) => r.form.startsWith("8-K") && daysBetween(r.filed, today) <= FILING_WATCH.seriousDays && r.items.some((i) => i in SERIOUS))
    .map((r) => ({ filed: r.filed, items: r.items.filter((i) => i in SERIOUS), accession: r.accession }));

  const maxLag = usualLags.length >= 3 ? Math.max(...usualLags) : null;
  const sinceEarnings = earnings ? businessDaysBetween(earnings.filed, today) : null;
  const lateVsUsual = maxLag !== null && sinceEarnings !== null && sinceEarnings > maxLag + (maxLag === 0 ? 0 : 2);
  const pastDue = today > (extendedTo ?? dueBy);
  const status: WatchStatus = serious.length ? "red_flag" : pastDue ? "past_due" : ntRow ? "nt_filed" : lateVsUsual ? "late_vs_usual" : "ok";

  const what = `its ${nextForm} for the ${nextForm === "10-Q" ? "quarter" : "year"} ended about ${fmt(periodEnd)}`;
  const due = `Due ${fmt(dueBy)} (${days} days after the period${size ? `, ${size}` : ", at the latest"})${extendedTo ? `, ${fmt(extendedTo)} with the notice` : ""}.`;
  const habit = maxLag !== null ? `it filed the report ${maxLag === 0 ? "the same day as earnings" : `within ${maxLag} business day${maxLag === 1 ? "" : "s"} of earnings`} in each of its last ${usualLags.length} reports` : null;
  const parts: string[] = [];
  if (serious.length) parts.push(`${symbol} filed an 8-K: ${serious.map((s) => `${s.items.map((i) => SERIOUS[i]).join(", ")} on ${fmt(s.filed)}`).join("; ")}.`);
  if (pastDue) parts.push(`${symbol} has not filed ${what}; it was due ${fmt(extendedTo ?? dueBy)}${ntRow ? " even with the late-filing notice" : ""}.`);
  else if (ntRow) parts.push(`${symbol} filed a late-filing notice (${ntRow.form}, Form 12b-25) on ${fmt(ntRow.filed)}: it says ${what} will be late. ${due}`);
  else if (lateVsUsual) parts.push(`${symbol} has not filed ${what}. Earnings came out ${fmt(earnings!.filed)} (8-K item 2.02); ${habit}, and it is now ${sinceEarnings} business day${sinceEarnings === 1 ? "" : "s"}. ${due}`);
  else if (earnings && !after.some((r) => PERIODIC.has(r.form))) parts.push(`${symbol}'s ${nextForm} is not filed yet (earnings ${fmt(earnings.filed)}${habit ? `; ${habit}` : ""}). ${due}`);
  else parts.push(`${symbol}'s last report: ${last.form} for the period ended ${fmt(last.report!)}, filed ${fmt(last.filed)}. Next: the ${nextForm}, ${due.charAt(0).toLowerCase()}${due.slice(1)}`);
  return { status, nextForm, periodEnd, dueBy, extendedTo, filerSize: size, earnings8k: earnings?.filed ?? null, usualLags, nt: ntRow ? { form: ntRow.form, filed: ntRow.filed, accession: ntRow.accession } : null, serious, message: parts.join(" ") };
}

interface Submissions { category?: string; filings?: { recent?: { accessionNumber: string[]; filingDate: string[]; reportDate: string[]; form: string[]; items: string[] } } }

/** Pure: the rows of a submissions document. */
export function submissionRows(s: Submissions): FilingRow[] {
  const r = s.filings?.recent;
  if (!r) return [];
  return r.form.map((form, i) => ({ form, filed: r.filingDate[i], report: r.reportDate?.[i] || null, items: (r.items?.[i] ?? "").split(",").map((x) => x.trim()).filter(Boolean), accession: r.accessionNumber[i] }));
}

export interface WatchRow { symbol: string; cik: string | null; checkedAt: string; status: WatchStatus; key: string; message: string; data: FilingStatus | null }

/** The latest watch result per symbol (all symbols when none are given). */
export async function latestFilingWatch(symbols?: string[]): Promise<Map<string, WatchRow>> {
  const rows = await q(`SELECT DISTINCT ON (symbol) * FROM filing_watch ${symbols ? "WHERE symbol = ANY($1)" : ""} ORDER BY symbol, checked_at DESC, id DESC`, symbols ? [symbols.map((s) => s.toUpperCase())] : []);
  return new Map(rows.map((r) => [String(r.symbol), { symbol: String(r.symbol), cik: (r.cik as string) ?? null, checkedAt: new Date(r.checked_at as string).toISOString(), status: r.status as WatchStatus, key: String(r.key), message: String(r.message ?? ""), data: (r.data as FilingStatus) ?? null }]));
}

/** Pure: what identifies a status, so a push goes out once per change. */
export const statusKey = (s: FilingStatus) => [s.status, s.periodEnd, s.nt?.accession ?? "", ...s.serious.map((x) => x.accession)].join("|");

/** The stocks watched: open paper trades, and every card from the last two weeks. */
async function watchedSymbols(): Promise<string[]> {
  const [tracks, cards] = await Promise.all([store.allTracks(), store.cardsSince(FILING_WATCH.recentCardDays)]);
  const open = tracks.filter((t) => !t.exitDate && !t.excluded).map((t) => t.symbol);
  return [...new Set([...open, ...cards.map((c) => c.primaryTicker)].map((s) => s.toUpperCase()))].slice(0, FILING_WATCH.maxSymbols);
}

/** One pass: check the watched stocks that are due (every few hours each); push a phone alert when a status turns bad. */
export async function runFilingWatch(deps: { now: Date; ua: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }, deadline: number, only?: string[]): Promise<string> {
  const symbols = only ?? (await watchedSymbols());
  if (!symbols.length) return "no card stocks";
  const today = toEt(deps.now).date;
  const ciks = new Map((await secTickerList(deps.ua, deps.fetchImpl)).map((e) => [e.ticker, e.cik] as const).reverse());
  const prev = await latestFilingWatch(symbols);
  let checked = 0;
  const flagged: Array<{ symbol: string; s: FilingStatus; resolved?: WatchStatus }> = [];
  for (const symbol of symbols) {
    if (Date.now() > deadline) break;
    const cik = ciks.get(symbol);
    if (!cik) continue;
    if (!only && !(await store.tryLock(`filingwatch:${symbol}`, FILING_WATCH.everyHours * 60))) continue;
    const sub = await getJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, { headers: { "user-agent": deps.ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 130, fetchImpl: deps.fetchImpl, retries: 1 }).catch(() => null);
    if (!sub) continue;
    checked++;
    const s = assessFilings(symbol, submissionRows(sub), sub.category ?? null, today);
    if (!s) continue;
    const key = statusKey(s);
    const before = prev.get(symbol);
    if (before?.key === key) continue;
    await q(`INSERT INTO filing_watch (symbol, cik, checked_at, status, key, message, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [symbol, cik, deps.now.toISOString(), s.status, key, s.message, JSON.stringify(s)]);
    if (s.status !== "ok") flagged.push({ symbol, s });
    else if (before && before.status !== "ok") flagged.push({ symbol, s, resolved: before.status });
  }
  if (flagged.length) {
    const { pushConfigured, sendPush } = await import("../notify");
    const env = deps.env ?? process.env;
    if (pushConfigured(env)) {
      const base = (env.DASHBOARD_URL ?? "").replace(/\/$/, "");
      for (const f of flagged.slice(0, 4)) await sendPush({ title: f.resolved ? `${f.symbol}: report filed` : `${f.symbol}: ${WATCH_LABEL[f.s.status]}`, message: f.s.message, click: `${base}/filings#watch`, tags: ["warning"], priority: f.resolved ? 3 : f.s.status === "red_flag" || f.s.status === "past_due" ? 5 : 4 }, env, deps.fetchImpl).catch(() => undefined);
    }
  }
  return `${checked} checked${flagged.length ? `, ${flagged.length} changed (${flagged.map((f) => `${f.symbol} ${f.s.status}`).join(", ")})` : ""}`;
}

export const WATCH_LABEL: Record<WatchStatus, string> = {
  ok: "filings on time",
  late_vs_usual: "report later than usual",
  nt_filed: "late-filing notice filed",
  past_due: "report past the SEC deadline",
  red_flag: "restatement or auditor change",
};
