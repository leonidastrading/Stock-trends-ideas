/**
 * When the filing-change reader runs, and on what:
 * - Stocks on cards (open paper tracks and cards from the last 60 days): each is checked for a new 10-K / 10-Q,
 *   oldest-checked first, a few per run. A red flag on a stock with an open track is pushed to the phone.
 * - Each week, a batch of small caps (public float $300M–$2B) that filed a 10-K / 10-Q in the last 7 days:
 *   10 picked per week, 2 read per run. One whose change the AI calls specific and material goes to research
 *   (at most 3 a week; those cards score as "Scout · filing changes").
 * Nothing is stored for a filing the day's AI budget turned away, so it is read on a later run.
 */
import { getJson, getText } from "../http";
import { cikFor } from "../sources/edgar";
import { addDays, toEt } from "../time";
import { diffLatest, diffLine, type FilingDiff } from "./filing-diff";
import type { ResearchDeps } from "./research";
import * as store from "./store";

export const FILING_DIFF = { cardChecksPerRun: 8, diffsPerRun: 3, smallcapPerWeek: 10, smallcapPerRun: 2, researchPerWeek: 3, floatMin: 300e6, floatMax: 2e9, budgetMs: 200_000 };

/** Pure: ISO-like week key of an ET date ("2026-W47"). */
export function weekKey(etDate: string): string {
  const d = new Date(`${etDate}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Pure: 10-K / 10-Q lines of an EDGAR daily form index. */
export function formIndex(idx: string): Array<{ form: string; company: string; cik: string; date: string }> {
  const out: Array<{ form: string; company: string; cik: string; date: string }> = [];
  for (const line of idx.split("\n")) {
    const m = /^(10-K|10-Q)\s+(.+?)\s{2,}(\d+)\s+(\d{8}|\d{4}-\d{2}-\d{2})\s+edgar\//.exec(line);
    if (m) out.push({ form: m[1], company: m[2].trim(), cik: m[3], date: m[4].length === 8 ? `${m[4].slice(0, 4)}-${m[4].slice(4, 6)}-${m[4].slice(6)}` : m[4] });
  }
  return out;
}

/** Pure: the latest public float per company from SEC "frames" (dei:EntityPublicFloat), newest frame first. */
export function floatsFrom(frames: Array<{ data?: Array<{ cik: number; val: number; end: string }> }>): Map<string, number> {
  const out = new Map<string, { val: number; end: string }>();
  for (const f of frames) for (const r of f.data ?? []) {
    const k = String(r.cik);
    const have = out.get(k);
    if (!have || r.end > have.end) out.set(k, { val: r.val, end: r.end });
  }
  return new Map([...out].map(([k, v]) => [k, v.val]));
}

/** Pure: a fixed pseudo-random order for the week (so the batch is the same however often it runs). */
export const weekOrder = <T,>(xs: T[], key: (x: T) => string, week: string) => xs.map((x) => ({ x, h: [...`${week}:${key(x)}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) })).sort((a, b) => a.h - b.h).map((y) => y.x);

const quarterFrames = (now: Date): string[] => {
  // The last six quarter-end instants at least 60 days old (companies report the float in the next 10-K).
  const out: string[] = [];
  let d = new Date(now.getTime() - 60 * 86400_000);
  while (out.length < 6) {
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    out.push(`CY${d.getUTCFullYear()}Q${q}I`);
    d = new Date(Date.UTC(d.getUTCFullYear(), (q - 1) * 3 - 1, 15));
  }
  return [...new Set(out)];
};

async function smallcapFloats(ua: string, now: Date, fetchImpl?: typeof fetch): Promise<Map<string, number>> {
  const cached = await store.cacheGet<Record<string, number>>("filingdiff:floats");
  if (cached && Date.now() - Date.parse(cached.updatedAt) < 7 * 86400_000) return new Map(Object.entries(cached.data));
  const frames = [];
  for (const f of quarterFrames(now)) frames.push(await getJson<{ data?: Array<{ cik: number; val: number; end: string }> }>(`https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/${f}.json`, { headers: { "user-agent": ua }, minIntervalMs: 150, cacheMs: 0, timeoutMs: 60_000, fetchImpl, retries: 1 }).catch(() => ({ data: [] })));
  const all = floatsFrom(frames);
  const small = Object.fromEntries([...all].filter(([, v]) => v >= FILING_DIFF.floatMin && v <= FILING_DIFF.floatMax));
  await store.cachePut("filingdiff:floats", small);
  return new Map(Object.entries(small));
}

interface SmallcapWeek { week: string; picks: Array<{ cik: string; ticker: string | null; company: string; form: string; date: string; done: boolean }> }

async function smallcapBatch(ua: string, now: Date, exclude: Set<string>, fetchImpl?: typeof fetch): Promise<SmallcapWeek> {
  const et = toEt(now);
  const week = weekKey(et.date);
  const cached = await store.cacheGet<SmallcapWeek>("filingdiff:smallcap");
  if (cached?.data.week === week) return cached.data;
  const floats = await smallcapFloats(ua, now, fetchImpl);
  const filed: Array<{ form: string; company: string; cik: string; date: string }> = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(et.date, -i);
    const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
    const idx = await getText(`https://www.sec.gov/Archives/edgar/daily-index/${d.slice(0, 4)}/QTR${q}/form.${d.replace(/-/g, "")}.idx`, { headers: { "user-agent": ua }, minIntervalMs: 150, cacheMs: 0, timeoutMs: 30_000, fetchImpl, retries: 0 }).catch(() => "");
    filed.push(...formIndex(idx));
  }
  const tickers = await getJson<Record<string, { cik_str: number; ticker: string }>>("https://www.sec.gov/files/company_tickers.json", { headers: { "user-agent": ua }, minIntervalMs: 150, cacheMs: 24 * 3600_000, fetchImpl }).catch(() => ({}) as Record<string, { cik_str: number; ticker: string }>);
  const tickerOf = new Map(Object.values(tickers).map((t) => [String(t.cik_str), t.ticker.replace(/-/g, ".")]));
  const seen = new Set<string>();
  const eligible = filed.filter((f) => floats.has(f.cik) && tickerOf.has(f.cik) && !exclude.has(tickerOf.get(f.cik)!) && !seen.has(f.cik) && seen.add(f.cik));
  const picks = weekOrder(eligible, (f) => f.cik, week).slice(0, FILING_DIFF.smallcapPerWeek).map((f) => ({ cik: f.cik, ticker: tickerOf.get(f.cik) ?? null, company: f.company, form: f.form, date: f.date, done: false }));
  const out = { week, picks };
  await store.cachePut("filingdiff:smallcap", out);
  return out;
}

/** Stocks on cards: open tracks first, then cards from the last 60 days. */
async function cardTickers(): Promise<string[]> {
  const [tracks, cards] = await Promise.all([store.allTracks().catch(() => []), store.cardsSince(60).catch(() => [])]);
  const open = tracks.filter((t) => !t.exitDate && !t.invalidatedAt).map((t) => t.symbol);
  return [...new Set([...open, ...cards.map((c) => c.primaryTicker)])].filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s));
}

async function maybeResearch(d: FilingDiff, deps: ResearchDeps): Promise<string | null> {
  if (d.source !== "smallcap" || !d.read?.research || d.read.research_direction === "none" || !d.ticker) return null;
  const { query } = await import("../db");
  const sent = Number((await query(`SELECT count(*) AS n FROM candidates WHERE term LIKE 'filing change:%' AND created_at > now() - interval '7 days'`))[0]?.n ?? 0);
  if (sent >= FILING_DIFF.researchPerWeek) return `research skipped (${sent} filing-change ideas this week)`;
  const { researchCandidate } = await import("./research");
  const context = [
    `The scout's filing-change reader compared ${d.company}'s ${d.form} filed ${d.filed} (${d.url}) with the one a year earlier (${d.priorUrl ?? "?"}).`,
    `Its read: ${d.read.flag.replace("_", " ")}: ${d.read.headline}. ${d.read.research_why}`,
    d.read.findings.map((f) => `- [${f.direction}] ${f.type}: ${f.why} Filing text: "${f.quote}"`).join("\n"),
    "Wording changes alone are weak evidence (the 'Lazy Prices' effect has faded in recent studies). Check whether the change is material and not yet priced, and look for confirmation before calling it.",
  ].join("\n\n");
  const r = await researchCandidate({ origin: "scout", term: `filing change: ${d.ticker} ${d.form} ${d.filed}`, kindHint: "event", tickersHint: [d.ticker], observation: null, context, source: { label: "Filing changes", url: `/filings?changes=1#diff-${d.accession}` }, proposedDirection: d.read.research_direction }, deps);
  return r.outcome === "card" ? `card #${r.card.id}` : `${r.outcome}: ${r.reason}`;
}

async function alertRedFlag(d: FilingDiff, env: NodeJS.ProcessEnv): Promise<void> {
  if (d.source !== "card" || d.read?.flag !== "red_flag" || !d.ticker) return;
  const tracks = await store.allTracks().catch(() => []);
  const open = tracks.find((t) => t.symbol === d.ticker && !t.exitDate && !t.invalidatedAt);
  if (!open) return;
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured(env) || !(await store.claimNotification(`filingdiff:${d.accession}`, `${d.ticker} filing change`))) return;
  const base = env.DASHBOARD_URL?.replace(/\/$/, "");
  await sendPush({ title: `Filing change: ${d.ticker} (open card #${open.cardId})`, message: diffLine(d).slice(0, 450), tags: ["page_facing_up"], priority: 3, ...(base ? { click: `${base}/filings?changes=1#diff-${d.accession}` } : {}) }, env);
}

/** One run: a few card stocks checked for new filings, then this week's small caps. Returns a log line. */
export async function runFilingDiffs(deps: ResearchDeps, budgetMs = FILING_DIFF.budgetMs): Promise<string> {
  const ua = deps.env.SEC_USER_AGENT?.trim();
  if (!ua) return "filing changes: SEC_USER_AGENT not set";
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const log: string[] = [];
  let diffs = 0;
  const handle = async (cik: string, ticker: string | null, source: "card" | "smallcap") => {
    const d = await diffLatest(cik, ticker, source, deps);
    if (!d) return false;
    diffs++;
    log.push(`${ticker ?? cik} ${d.form} ${d.flag}`);
    await alertRedFlag(d, deps.env).catch(() => undefined);
    const r = await maybeResearch(d, deps).catch((e) => `research failed: ${e instanceof Error ? e.message : String(e)}`);
    if (r) log.push(`  → ${r}`);
    return true;
  };
  try {
    // Stocks on cards, oldest-checked first.
    const checked = (await store.cacheGet<Record<string, string>>("filingdiff:checked"))?.data ?? {};
    const tickers = (await cardTickers()).sort((a, b) => (checked[a] ?? "").localeCompare(checked[b] ?? ""));
    for (const t of tickers.slice(0, FILING_DIFF.cardChecksPerRun)) {
      if (left() < 60_000 || diffs >= FILING_DIFF.diffsPerRun) break;
      const cik = await cikFor(t, { "user-agent": ua }, deps.fetchImpl).catch(() => null);
      checked[t] = new Date().toISOString();
      if (cik) await handle(cik, t, "card").catch((e) => { if (e instanceof Error && e.message === "capped") throw e; log.push(`${t}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`); });
    }
    await store.cachePut("filingdiff:checked", checked);
    // This week's small caps.
    if (left() > 90_000 && diffs < FILING_DIFF.diffsPerRun) {
      const batch = await smallcapBatch(ua, deps.now, new Set(tickers), deps.fetchImpl);
      for (const p of batch.picks.filter((x) => !x.done).slice(0, FILING_DIFF.smallcapPerRun)) {
        if (left() < 60_000) break;
        await handle(p.cik, p.ticker, "smallcap").catch((e) => { if (e instanceof Error && e.message === "capped") throw e; log.push(`${p.ticker ?? p.cik}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`); });
        p.done = true;
      }
      await store.cachePut("filingdiff:smallcap", batch);
      log.push(`small caps this week: ${batch.picks.filter((x) => x.done).length} of ${batch.picks.length} read`);
    }
  } catch (e) {
    if (e instanceof Error && e.message === "capped") log.push("stopped: daily AI budget reached (read on a later run)");
    else log.push(`failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
  return `filing changes: ${diffs} read${log.length ? ` · ${log.join(" · ")}` : ""}`;
}
