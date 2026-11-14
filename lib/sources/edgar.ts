/**
 * SEC EDGAR, within the SEC's rules for automated access: a declared
 * User-Agent ("Name email", SEC_USER_AGENT), at most ~8 requests a second,
 * and the free JSON APIs on data.sec.gov rather than scraped pages.
 *
 * Per linked ticker (up to 3):
 *  - filings in the last 30 days (8-K, 10-Q, 10-K, 6-K, 20-F) against the
 *    monthly average over 12 months, from the submissions API;
 *  - material events in 90 days from 8-K item codes (1.01 material agreement,
 *    2.01 acquisition, 2.03 new debt, 5.02 officer change...), with links;
 *  - quarterly revenue against the same quarter a year earlier, from the
 *    XBRL company-concept API.
 *
 * Full-text search across all filers (efts.sec.gov) refuses cloud addresses,
 * so it runs only through the relay in relay/ when EDGAR_PROXY_URL /
 * EDGAR_PROXY_TOKEN point at one on a network the SEC accepts.
 */
import { getJson, HttpError } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Signal, type Source } from "./types";

const MAX_TICKERS = 3;
const MIN_INTERVAL_MS = 125; // stays under the SEC's 10 requests a second
const FORMS = new Set(["8-K", "8-K/A", "10-Q", "10-K", "6-K", "20-F", "40-F"]);

export const ITEM_LABELS: Record<string, string> = {
  "1.01": "material agreement",
  "1.02": "agreement terminated",
  "1.03": "bankruptcy",
  "2.01": "acquisition or disposal",
  "2.02": "results",
  "2.03": "new debt",
  "2.05": "restructuring",
  "2.06": "impairment",
  "3.01": "listing notice",
  "4.02": "restatement",
  "5.02": "officer or director change",
  "7.01": "Reg FD disclosure",
  "8.01": "other event",
};
/** Items worth surfacing as events (results and exhibits are routine). */
const EVENT_ITEMS = new Set(["1.01", "1.02", "1.03", "2.01", "2.03", "2.05", "2.06", "3.01", "4.02", "5.02", "8.01"]);

export interface Submissions { cik: string; name?: string; filings: { recent: { accessionNumber: string[]; filingDate: string[]; form: string[]; items: string[]; primaryDocument: string[] } } }
interface Concept { units?: { USD?: Array<{ end: string; val: number; frame?: string; form?: string }> } }
interface Fts { hits: { total: { value: number }; hits: Array<{ _source: { display_names?: string[]; form_type?: string; file_date?: string } }> } }

// ------------------------------------------------------------------ pure

/** Filing counts and material 8-K events from a submissions document. */
export function filingActivity(s: Submissions, now: Date) {
  const r = s.filings.recent;
  const d30 = dateStr(daysAgo(now, 30));
  const d90 = dateStr(daysAgo(now, 90));
  const d365 = dateStr(daysAgo(now, 365));
  let last30 = 0;
  let last365 = 0;
  const forms30: string[] = [];
  const events: Array<{ date: string; form: string; items: string[]; url: string }> = [];
  const cikNum = String(Number(s.cik));
  for (let i = 0; i < r.form.length; i++) {
    const date = r.filingDate[i];
    const form = r.form[i];
    if (!FORMS.has(form) || date < d365) continue;
    last365++;
    if (date >= d30) {
      last30++;
      forms30.push(form);
    }
    if (date >= d90 && form.startsWith("8-K")) {
      const items = (r.items[i] ?? "").split(",").map((x) => x.trim()).filter((x) => EVENT_ITEMS.has(x));
      if (items.length) events.push({ date, form, items, url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}` });
    }
  }
  return { last30, monthly12: r1(last365 / 12), forms30, events };
}

/** Latest calendar quarter's revenue against the same quarter a year earlier. */
export function revenueYoY(c: Concept): { latest: { frame: string; end: string; val: number }; prior: { frame: string; val: number }; growthPct: number } | null {
  const q = (c.units?.USD ?? []).filter((x) => x.frame && /^CY\d{4}Q\d$/.test(x.frame));
  if (!q.length) return null;
  const latest = q.slice().sort((a, b) => a.end.localeCompare(b.end)).at(-1)!;
  const [, y, n] = /^CY(\d{4})Q(\d)$/.exec(latest.frame!)!;
  const prior = q.find((x) => x.frame === `CY${Number(y) - 1}Q${n}`);
  if (!prior || prior.val <= 0) return null;
  return { latest: { frame: latest.frame!, end: latest.end, val: latest.val }, prior: { frame: prior.frame!, val: prior.val }, growthPct: Math.round((latest.val / prior.val - 1) * 1000) / 10 };
}

const money = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`);

// ------------------------------------------------------------------- io

/** SEC ticker list uses dashes for share classes (BRK-B). */
async function cikFor(ticker: string, headers: Record<string, string>, fetchImpl?: typeof fetch): Promise<string | null> {
  const list = await getJson<Record<string, { cik_str: number; ticker: string }>>("https://www.sec.gov/files/company_tickers.json", { headers, minIntervalMs: MIN_INTERVAL_MS, cacheMs: 24 * 60 * 60000, fetchImpl });
  const want = ticker.toUpperCase().replace(/\./g, "-");
  const hit = Object.values(list).find((x) => x.ticker.toUpperCase() === want);
  return hit ? String(hit.cik_str).padStart(10, "0") : null;
}

async function revenue(cik: string, headers: Record<string, string>, fetchImpl?: typeof fetch) {
  let best: ReturnType<typeof revenueYoY> = null;
  for (const tag of ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]) {
    try {
      const r = revenueYoY(await getJson<Concept>(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { headers, minIntervalMs: MIN_INTERVAL_MS, cacheMs: 12 * 60 * 60000, fetchImpl, retries: 1 }));
      if (r && (!best || r.latest.end > best.latest.end)) best = r;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  return best;
}

/** Full-text search through the relay (never direct: efts.sec.gov refuses cloud addresses). */
export function relayRoute(env: NodeJS.ProcessEnv): { url: (target: string) => string; headers: Record<string, string> } | null {
  const relay = env.EDGAR_PROXY_URL?.replace(/\/$/, "");
  return relay && env.EDGAR_PROXY_TOKEN ? { url: (t) => `${relay}/fetch?url=${encodeURIComponent(t)}`, headers: { authorization: `Bearer ${env.EDGAR_PROXY_TOKEN}` } } : null;
}

async function fullText(term: string, now: Date, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Signal | null> {
  const r = relayRoute(env);
  if (!r) return null;
  const today = dateStr(now);
  const q = (start: string) => getJson<Fts>(r.url(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${term}"`)}&forms=8-K,10-K,10-Q&dateRange=custom&startdt=${start}&enddt=${today}`), { headers: r.headers, minIntervalMs: MIN_INTERVAL_MS, fetchImpl });
  const [m1, y1] = [await q(dateStr(daysAgo(now, 30))), await q(dateStr(daysAgo(now, 365)))];
  const monthly12 = r1(y1.hits.total.value / 12);
  const ch = change(m1.hits.total.value, monthly12);
  return {
    source: "edgar", metric: "filings_30d", value: m1.hits.total.value, baseline: monthly12, changeVs12m: ch, asOf: today,
    note: `${m1.hits.total.value} filings (8-K/10-Q/10-K) mention "${term}" in 30 days vs ${monthly12}/month over 12 months (${pct(ch)})`,
    detail: { recent_filers: m1.hits.hits.slice(0, 8).map((h) => ({ filer: h._source.display_names?.[0] ?? "?", form: h._source.form_type, date: h._source.file_date })) },
  };
}

export const edgar: Source = {
  id: "edgar",
  label: "SEC EDGAR",
  about: "Per linked ticker: filings in 30 days vs the 12-month pace, material 8-K events (agreements, acquisitions, officer changes) in 90 days, and quarterly revenue vs a year earlier, from data.sec.gov. Full-text search across all filers only through the relay.",
  configured: (env) => !!env.SEC_USER_AGENT || !!relayRoute(env),
  probe: (ctx) =>
    guarded("edgar", async () => {
      const ua = ctx.env.SEC_USER_AGENT?.trim();
      const signals: Signal[] = [];
      const problems: string[] = [];
      const today = dateStr(ctx.now);

      try {
        const ft = await fullText(ctx.term, ctx.now, ctx.env, ctx.fetchImpl);
        if (ft) signals.push(ft);
      } catch (err) {
        problems.push(`full-text search via relay failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }

      if (!ua) {
        if (!signals.length) return { source: "edgar", status: "missing", detail: "SEC_USER_AGENT not set (the SEC requires \"Name email\")", signals: [] };
      } else {
        const headers = { "user-agent": ua, "accept-encoding": "gzip, deflate" };
        for (const ticker of ctx.tickers.slice(0, MAX_TICKERS)) {
          const cik = await cikFor(ticker, headers, ctx.fetchImpl);
          if (!cik) {
            problems.push(`${ticker}: not an SEC filer (foreign or unlisted?)`);
            continue;
          }
          const subs = await getJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers, minIntervalMs: MIN_INTERVAL_MS, cacheMs: 6 * 60 * 60000, fetchImpl: ctx.fetchImpl });
          const a = filingActivity(subs, ctx.now);
          const ch = change(a.last30, a.monthly12);
          const ev = a.events.map((e) => `${e.date} ${e.items.map((i) => ITEM_LABELS[i] ?? i).join(" + ")}`);
          signals.push({
            source: "edgar", metric: `filings_30d:${ticker}`, value: a.last30, baseline: a.monthly12, changeVs12m: ch, asOf: today,
            note: `${ticker}: ${a.last30} filings in 30 days (${a.forms30.join(", ") || "none"}) vs ${a.monthly12}/month over 12 months (${pct(ch)})${ev.length ? `; 8-K events in 90 days: ${ev.slice(0, 5).join("; ")}` : ""}`,
            detail: { events_90d: a.events.slice(0, 8) },
          });
          if (a.events.length) {
            signals.push({
              source: "edgar", metric: `material_events_90d:${ticker}`, value: a.events.length, baseline: null, changeVs12m: null, asOf: a.events[0].date,
              note: `${ticker}: ${a.events.length} 8-K material event(s) in 90 days, latest ${a.events[0].date}: ${a.events[0].items.map((i) => ITEM_LABELS[i] ?? i).join(" + ")} (${a.events[0].url})`,
              detail: { events: a.events.slice(0, 8) },
            });
          }
          const rev = await revenue(cik, headers, ctx.fetchImpl).catch((err) => {
            problems.push(`${ticker} revenue: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
            return null;
          });
          if (rev) {
            signals.push({
              source: "edgar", metric: `revenue_yoy_pct:${ticker}`, value: rev.growthPct, baseline: null, changeVs12m: null, asOf: rev.latest.end,
              note: `${ticker}: quarterly revenue ${money(rev.latest.val)} for the quarter ended ${rev.latest.end} vs ${money(rev.prior.val)} a year earlier (${rev.growthPct >= 0 ? "+" : ""}${rev.growthPct}%), from XBRL filings`,
            });
          }
        }
        if (!ctx.tickers.length && !relayRoute(ctx.env)) problems.push("no linked tickers to look up; market-wide full-text search needs the relay");
      }
      return { source: "edgar", status: "ok", detail: problems.length ? problems.join("; ") : undefined, signals };
    }),
};

/** Kept for the relay test and older callers. */
export const route = relayRoute;
