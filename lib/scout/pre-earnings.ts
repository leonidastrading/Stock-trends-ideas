/**
 * The pre-earnings screen: warning signs on a stock in the days BEFORE it reports, and what happened after.
 *
 * Where it came from: Ambarella (AMBA) fell hard on its November 24, 2026 results. Looking back, the signs were on
 * the scout's own pages beforehand, in different places and never put together: the stock had lost a third in 30
 * days, its latest 10-Q had added a risk the filing reader tagged negative, it had dropped 20% in the session before
 * the report with no headline, and it had fallen through a takeover report. This puts them together, by code only
 * (no AI), for every company reporting in the next five sessions:
 *
 *   slide   the stock is 20+ points behind SPY over 30 days
 *   jolt    one of the last three sessions fell 3 times its usual daily move (5%+), with no headline that day or the day before
 *   filing  the latest 10-K / 10-Q, against a year earlier, added a risk the filing reader tagged negative, or warning words rose
 *   idea    a short idea on Dots or Themes names it
 *   fade    takeover talk was reported in the last 30 days and the stock is lower than before it
 *
 * Two or more signs is a flag. Every screened stock is kept with its signs, and after the report the reaction is
 * written beside it (against SPY), flagged or not, so the screen's record builds forward and can be read against the
 * stocks it did not flag. It is unproven until that record says otherwise: a flag is a reason to look, not a call.
 */
import type { DailyBar, MarketData, NewsItem } from "../alpaca";
import { query as q } from "../db";
import { calendarDay, type EarningsReport, type Timing } from "../sources/earnings-data";
import { addDays, toEt } from "../time";
import type { DotsRun } from "./dots";
import type { Mechanical } from "./filing-diff";
import { stat, type Stat } from "./rating-study";
import { takeoverTalk } from "./stories";
import * as store from "./store";
import type { ThemeRun } from "./themes";

export const PRE_EARNINGS = {
  aheadSessions: 5, minCapUsd: 300e6, flagAt: 2,
  slide: { days: 30, vsSpy: -20 },
  jolt: { times: 3, minPct: 5, base: 60, lookback: 3 },
  filingDays: 150, ideaDays: 21,
  fade: { days: 30, minFall: -3 },
  newsFor: 40, readsPerRun: 4, pushPerDay: 6, measureDays: 12, budgetMs: 200_000,
};

export type LegKind = "slide" | "jolt" | "filing" | "idea" | "fade";
export interface Leg { kind: LegKind; text: string; url?: string }
export const LEG_NAME: Record<LegKind, string> = { slide: "slide", jolt: "unexplained drop", filing: "filing warning", idea: "short idea", fade: "fell through takeover talk" };

type Bar = Pick<DailyBar, "date" | "c">;
const r1 = (x: number) => Math.round(x * 10) / 10;
const sign = (x: number) => `${x > 0 ? "+" : ""}${x}%`;

/** Pure: the move over the last `days` calendar days, and SPY's over the same days (bars oldest first). */
export function slideOf(bars: Bar[], spy: Bar[], days = PRE_EARNINGS.slide.days): { pct: number; spyPct: number | null } | null {
  const last = bars.at(-1);
  if (!last) return null;
  const from = addDays(last.date, -days);
  const move = (xs: Bar[]) => {
    const end = [...xs].reverse().find((b) => b.date <= last.date), base = [...xs].reverse().find((b) => b.date <= from);
    return end && base && base.c > 0 ? r1((end.c / base.c - 1) * 100) : null;
  };
  // A stock listed for less than the window has no 30-day move.
  if (bars[0].date > from) return null;
  const pct = move(bars);
  return pct === null ? null : { pct, spyPct: move(spy) };
}

export function slideLeg(s: { pct: number; spyPct: number | null } | null, cfg = PRE_EARNINGS.slide): Leg | null {
  if (!s || s.pct - (s.spyPct ?? 0) > cfg.vsSpy) return null;
  return { kind: "slide", text: `down ${Math.abs(s.pct)}% in ${cfg.days} days${s.spyPct === null ? "" : ` (SPY ${sign(s.spyPct)})`}` };
}

/** Pure: the latest of the last few sessions that fell several times the stock's usual daily move (the median of the 60 before it). */
export function joltOf(bars: Bar[], cfg = PRE_EARNINGS.jolt): { date: string; pct: number; usual: number } | null {
  const rets = bars.slice(1).map((b, i) => ({ date: b.date, r: bars[i].c > 0 ? (b.c / bars[i].c - 1) * 100 : 0 }));
  for (let k = rets.length - 1; k >= Math.max(0, rets.length - cfg.lookback); k--) {
    const before = rets.slice(Math.max(0, k - cfg.base), k).map((x) => Math.abs(x.r)).sort((a, b) => a - b);
    if (before.length < 20) return null;
    const usual = before[Math.floor(before.length / 2)];
    if (rets[k].r <= -Math.max(cfg.minPct, cfg.times * usual)) return { date: rets[k].date, pct: r1(rets[k].r), usual: r1(usual) };
  }
  return null;
}

/** Pure: headlines on the day of a move or the day before (ET days). */
export const headlinesNear = (news: Array<Pick<NewsItem, "ts">>, date: string): number => news.filter((n) => { const d = toEt(new Date(n.ts)).date; return d === date || d === addDays(date, -1); }).length;

export function joltLeg(j: { date: string; pct: number; usual: number } | null, headlines: number | null): Leg | null {
  if (!j || headlines === null || headlines > 0) return null;
  return { kind: "jolt", text: `fell ${Math.abs(j.pct)}% on ${j.date} with no headline that day or the day before (its usual daily move is ${j.usual}%)` };
}

/** Watch words that are bad news when they turn up more often. */
export const WARNING_WORDS = ["shortage", "constrained", "going concern", "material weakness", "restatement", "impairment", "subpoena", "investigation", "class action", "tariff", "export controls", "covenant", "layoffs / restructuring"];

export interface FilingNote { form: string; filed: string; url: string; accession?: string; flag: string | null; negatives: string[]; shifts: Mechanical["shifts"] }

/** Pure: warning words that turned up more often than a year earlier. */
export const risingWarnings = (shifts: Mechanical["shifts"]) => shifts.filter((s) => WARNING_WORDS.includes(s.word) && s.after > s.before);

/**
 * Pure: the filing sign. With the AI's read on file, the read decides (a red flag, or a negative finding in a filing
 * it did not call positive); without one, warning words that rose are enough to count.
 */
export function filingLeg(n: FilingNote | null, today: string, days = PRE_EARNINGS.filingDays): Leg | null {
  if (!n || n.filed < addDays(today, -days)) return null;
  const head = `${n.form} filed ${n.filed}`;
  if (n.flag !== null) {
    if (n.flag !== "red_flag" && !(n.negatives.length && n.flag !== "positive")) return null;
    return { kind: "filing", url: n.url, text: `${head}: ${n.flag === "red_flag" ? "red flag" : "a negative change"} against a year earlier${n.negatives[0] ? ` (${n.negatives[0].replace(/\s+/g, " ").slice(0, 160)})` : ""}` };
  }
  const up = risingWarnings(n.shifts);
  if (!up.length) return null;
  return { kind: "filing", url: n.url, text: `${head}: warning words rose against a year earlier (${up.slice(0, 4).map((s) => `"${s.word}" ${s.before} → ${s.after} per 10,000 words`).join(", ")})` };
}

/** Pure: a short idea on Dots or Themes in the last weeks that names the stock. */
export function ideaLeg(symbol: string, dots: Array<Pick<DotsRun, "etDate" | "ideas">>, themes: Array<Pick<ThemeRun, "etDate" | "themes">>, today: string, days = PRE_EARNINGS.ideaDays): Leg | null {
  const since = addDays(today, -days);
  const hits = [
    ...dots.filter((r) => r.etDate >= since).flatMap((r) => r.ideas.filter((i) => i.direction === "short" && i.tickers.includes(symbol)).map((i) => ({ page: "Dots", date: r.etDate, title: i.title }))),
    ...themes.filter((r) => r.etDate >= since).flatMap((r) => r.themes.filter((t) => t.direction === "short" && t.tickers.includes(symbol)).map((t) => ({ page: "Themes", date: r.etDate, title: t.title }))),
  ].sort((a, b) => b.date.localeCompare(a.date));
  return hits.length ? { kind: "idea", url: hits[0].page === "Dots" ? "/dots" : "/themes", text: `named in a short idea on ${hits[0].page} (${hits[0].date}): "${hits[0].title.slice(0, 110)}"` } : null;
}

/** Pure: takeover talk in the news, and the stock lower now than at the close before the first report. */
export function fadeLeg(news: Array<Pick<NewsItem, "ts" | "headline" | "url">>, bars: Bar[], cfg = PRE_EARNINGS.fade): Leg | null {
  const talk = news.filter((n) => takeoverTalk(n.headline)).sort((a, b) => a.ts.localeCompare(b.ts))[0];
  const last = bars.at(-1);
  if (!talk || !last) return null;
  const day = toEt(new Date(talk.ts)).date;
  const base = [...bars].reverse().find((b) => b.date < day);
  if (!base || !(base.c > 0)) return null;
  const pct = r1((last.c / base.c - 1) * 100);
  return pct <= cfg.minFall ? { kind: "fade", url: talk.url || undefined, text: `takeover talk was reported on ${day} ("${talk.headline.slice(0, 90)}") and the stock is ${sign(pct)} since the close before it` } : null;
}

/**
 * Pure: whether the stock can still be screened: before its report day, or on the day itself for an after-close
 * reporter until the bell (the day's fall before the report is part of the picture; after the bell the report is out).
 */
export function canScreen(reportDate: string, timing: Timing, today: string, minutes: number): boolean {
  return today < reportDate || (today === reportDate && timing === "after_close" && minutes < 16 * 60);
}

/** Pure: the next weekdays from `today` on (the calendar is asked for each; a holiday simply lists nothing). */
export function nextWeekdays(today: string, n = PRE_EARNINGS.aheadSessions): string[] {
  const out: string[] = [];
  for (let d = today; out.length < n; d = addDays(d, 1)) { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d); }
  return out;
}

export interface Reaction { refDate: string; refClose: number; outDate: string; pct: number; spyPct: number | null }

/**
 * Pure: the reaction to the report, close to close. Before the open: the close before the report day to that day's
 * close. After the close: the report day's close to the next session's. Time not given: the close before the report
 * day to the close of the session after it (both cases fall inside).
 */
export function reactionOf(reportDate: string, timing: Timing, bars: Bar[], spy: Bar[]): Reaction | null {
  const ref = timing === "after_close" ? [...bars].reverse().find((b) => b.date <= reportDate) : [...bars].reverse().find((b) => b.date < reportDate);
  const out = timing === "before_open" ? bars.find((b) => b.date >= reportDate) : bars.find((b) => b.date > reportDate);
  if (!ref || !out || !(ref.c > 0) || out.date <= ref.date) return null;
  const s0 = spy.find((b) => b.date === ref.date), s1 = spy.find((b) => b.date === out.date);
  return { refDate: ref.date, refClose: ref.c, outDate: out.date, pct: r1((out.c / ref.c - 1) * 100), spyPct: s0 && s1 && s0.c > 0 ? r1((s1.c / s0.c - 1) * 100) : null };
}

export interface PreEarningsRow {
  symbol: string; name: string; reportDate: string; timing: Timing; marketCap: number | null;
  legs: Leg[]; flagged: boolean; firstFlaggedAt: string | null; move30: number | null; spy30: number | null;
  refDate: string | null; refClose: number | null; outDate: string | null; reactionPct: number | null; spyPct: number | null; measuredAt: string | null; screenedAt: string;
}

const day = (v: unknown) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const toRow = (r: Record<string, unknown>): PreEarningsRow => ({
  symbol: String(r.symbol), name: String(r.name ?? ""), reportDate: day(r.report_date)!, timing: r.timing as Timing, marketCap: num(r.market_cap),
  legs: (typeof r.legs === "string" ? JSON.parse(r.legs) : r.legs) as Leg[] ?? [], flagged: !!r.flagged, firstFlaggedAt: r.first_flagged_at ? new Date(r.first_flagged_at as string).toISOString() : null,
  move30: num(r.move30), spy30: num(r.spy30), refDate: day(r.ref_date), refClose: num(r.ref_close), outDate: day(r.out_date), reactionPct: num(r.reaction_pct), spyPct: num(r.spy_pct),
  measuredAt: r.measured_at ? new Date(r.measured_at as string).toISOString() : null, screenedAt: new Date(r.screened_at as string).toISOString(),
});

export interface ScoreRow { group: "flagged" | "one sign" | "no sign"; n: number; vsSpy: Stat; fellPct: number | null; fell5Pct: number | null }

export interface Scored { flagged: boolean; signs: number; reactionPct: number | null; spyPct: number | null }

/** Pure: the record so far. Each group's reaction against SPY, the share that did worse than SPY and the share 5+ points worse. */
export function scoreTable(rows: Scored[]): ScoreRow[] {
  const done = rows.filter((r) => r.reactionPct !== null);
  const groups: Array<[ScoreRow["group"], Scored[]]> = [["flagged", done.filter((r) => r.flagged)], ["one sign", done.filter((r) => !r.flagged && r.signs === 1)], ["no sign", done.filter((r) => !r.flagged && r.signs === 0)]];
  return groups.map(([group, rs]) => {
    const xs = rs.map((r) => r1(r.reactionPct! - (r.spyPct ?? 0)));
    const share = (f: (x: number) => boolean) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 100) : null);
    return { group, n: xs.length, vsSpy: stat(xs), fellPct: share((x) => x < 0), fell5Pct: share((x) => x <= -5) };
  });
}

/** The record over every measured report (a light read: no signs, only counts and reactions). */
export async function preEarningsRecord(): Promise<ScoreRow[]> {
  return scoreTable((await q(`SELECT flagged, n_legs, reaction_pct, spy_pct FROM pre_earnings WHERE measured_at IS NOT NULL`)).map((r) => ({ flagged: !!r.flagged, signs: Number(r.n_legs), reactionPct: num(r.reaction_pct), spyPct: num(r.spy_pct) })));
}

/** Pure: the record in one line. */
export function scoreLine(t: ScoreRow[]): string {
  return t.map((r) => `${r.group} n=${r.n}${r.vsSpy.mean === null ? "" : `: ${sign(r.vsSpy.mean)} avg vs SPY, ${r.fellPct}% worse than SPY, ${r.fell5Pct}% 5+ points worse`}`).join(" | ");
}

/** Pure: a row as a sentence (a phone alert, a research note). */
export function preEarningsLine(r: Pick<PreEarningsRow, "symbol" | "reportDate" | "timing" | "legs">): string {
  const when = r.timing === "before_open" ? "before the open" : r.timing === "after_close" ? "after the close" : "time not given";
  return `${r.symbol} reports ${r.reportDate} (${when}). Warning signs seen beforehand: ${r.legs.map((l) => l.text).join("; ")}.`;
}

/** Stocks still to report (soonest first) and the ones already measured (newest first). */
export async function preEarnings(today: string, pastDays = 60): Promise<{ ahead: PreEarningsRow[]; past: PreEarningsRow[] }> {
  const rows = (await q(`SELECT * FROM pre_earnings WHERE report_date >= $1 AND n_legs > 0 ORDER BY report_date`, [addDays(today, -pastDays)])).map(toRow);
  return { ahead: rows.filter((r) => !r.measuredAt && r.reportDate >= today && r.legs.length > 0), past: rows.filter((r) => r.measuredAt && r.legs.length > 0).reverse() };
}

/** The screen's rows for these stocks that have signs and are still to report or reported in the last days (research and chat background). */
export async function preEarningsFor(symbols: string[], today: string): Promise<PreEarningsRow[]> {
  if (!symbols.length) return [];
  return (await q(`SELECT * FROM pre_earnings WHERE symbol = ANY($1) AND n_legs > 0 AND report_date >= $2 ORDER BY report_date DESC`, [symbols, addDays(today, -7)])).map(toRow);
}

const bySymbol = (bars: DailyBar[]): Map<string, DailyBar[]> => {
  const m = new Map<string, DailyBar[]>();
  for (const b of bars) m.set(b.symbol, [...(m.get(b.symbol) ?? []), b]);
  for (const list of m.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return m;
};

/** Write the reaction beside every row whose report is behind it (flagged or not). */
async function measure(data: MarketData, today: string, now: Date): Promise<number> {
  const due = (await q(`SELECT * FROM pre_earnings WHERE measured_at IS NULL AND report_date < $1 AND report_date >= $2`, [today, addDays(today, -PRE_EARNINGS.measureDays)])).map(toRow);
  if (!due.length) return 0;
  const from = addDays(due.reduce((m, r) => (r.reportDate < m ? r.reportDate : m), today), -8);
  const bars = bySymbol(await data.getDailyBars([...new Set(due.map((r) => r.symbol)), "SPY"], from, today, { feed: "sip", adjustment: "all" }));
  const spy = bars.get("SPY") ?? [];
  let n = 0;
  for (const r of due) {
    // Only finished sessions: today's bar is still moving.
    const x = reactionOf(r.reportDate, r.timing, (bars.get(r.symbol) ?? []).filter((b) => b.date < today), spy);
    if (!x) continue;
    await q(`UPDATE pre_earnings SET ref_date = $3, ref_close = $4, out_date = $5, reaction_pct = $6, spy_pct = $7, measured_at = $8 WHERE symbol = $1 AND report_date = $2`, [r.symbol, r.reportDate, x.refDate, x.refClose, x.outDate, x.pct, x.spyPct, now.toISOString()]);
    n++;
  }
  return n;
}

interface MechNote extends FilingNote { at: string }

/** The newest filing comparison on file for each stock (only the parts the screen reads: the stored paragraphs are large). */
async function storedFilingNotes(symbols: string[], since: string): Promise<Map<string, FilingNote>> {
  const rows = await q(
    `SELECT DISTINCT ON (ticker) ticker, accession, form, filed, url, ai->>'flag' AS ai_flag, ai->'findings' AS findings, mechanical->'shifts' AS shifts
     FROM filing_diffs WHERE ticker = ANY($1) AND filed >= $2 AND flag NOT IN ('error', 'no_prior') ORDER BY ticker, filed DESC`, [symbols, since]);
  const json = <T,>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : typeof v === "string" ? JSON.parse(v) as T : v as T);
  return new Map(rows.map((r) => [String(r.ticker), {
    form: String(r.form), filed: day(r.filed)!, url: String(r.url ?? ""), accession: String(r.accession), flag: (r.ai_flag as string) ?? null,
    negatives: json<Array<{ direction?: string; why?: string; quote?: string }>>(r.findings, []).filter((f) => f.direction === "negative").map((f) => f.why || f.quote || "").filter(Boolean),
    shifts: json<Mechanical["shifts"]>(r.shifts, []),
  } satisfies FilingNote]));
}

/** One pass: measure the reports behind us, then screen every stock reporting in the next sessions. */
export async function runPreEarnings(deps: { data?: MarketData | null; env: NodeJS.ProcessEnv; now: Date; fetchImpl?: typeof fetch }): Promise<string> {
  const data = deps.data ?? null;
  if (!data) return "pre-earnings: waiting for market data (Alpaca keys)";
  const started = Date.now();
  const et = toEt(deps.now), today = et.date;
  const measured = await measure(data, today, deps.now).catch((e) => { console.warn(`pre-earnings measure: ${e instanceof Error ? e.message : e}`); return 0; });

  const days = nextWeekdays(today);
  const calendars = await Promise.all(days.map((d) => calendarDay(d, deps.fetchImpl).catch(() => null)));
  if (calendars.every((c) => c === null)) return `pre-earnings: the earnings calendar could not be read (${measured} past reports measured)`;
  // A report date that moved: the row under the old date is dropped (only for days whose calendar was read).
  for (let i = 0; i < days.length; i++) {
    const c = calendars[i];
    if (c?.length) await q(`DELETE FROM pre_earnings WHERE report_date = $1 AND measured_at IS NULL AND NOT (symbol = ANY($2))`, [days[i], c.map((r) => r.symbol)]).catch(() => undefined);
  }
  const reports = new Map<string, EarningsReport>();
  for (const r of calendars.flatMap((c) => c ?? [])) if ((r.marketCap ?? 0) >= PRE_EARNINGS.minCapUsd && canScreen(r.reportDate, r.timing, today, et.minutes) && !reports.has(r.symbol)) reports.set(r.symbol, r);
  const symbols = [...reports.keys()];
  if (!symbols.length) return `pre-earnings: nothing to screen in the next ${days.length} sessions (${measured} past reports measured)`;

  const bars = bySymbol(await data.getDailyBars([...symbols, "SPY"], addDays(today, -130), today, { feed: "sip", adjustment: "all" }));
  const spy = bars.get("SPY") ?? [];
  const [stored, dots, themes] = await Promise.all([
    storedFilingNotes(symbols, addDays(today, -PRE_EARNINGS.filingDays)).catch(() => new Map<string, FilingNote>()),
    import("./dots").then(({ dotsRuns }) => dotsRuns(30)).catch(() => [] as DotsRun[]),
    import("./themes").then(({ themeRuns }) => themeRuns(30)).catch(() => [] as ThemeRun[]),
  ]);

  // The signs that cost nothing, for every stock.
  const found = symbols.map((symbol) => {
    const b = bars.get(symbol) ?? [];
    const slide = slideOf(b, spy);
    const legs = [slideLeg(slide), filingLeg(stored.get(symbol) ?? null, today), ideaLeg(symbol, dots, themes, today)].filter((l): l is Leg => !!l);
    return { r: reports.get(symbol)!, b, slide, jolt: joltOf(b), legs };
  });

  // Headlines (the unexplained drop and the takeover fade) for the stocks that already show something, biggest first.
  const wantNews = found.filter((f) => f.legs.length || f.jolt).sort((a, b) => (b.r.marketCap ?? 0) - (a.r.marketCap ?? 0)).slice(0, PRE_EARNINGS.newsFor);
  for (const f of wantNews) {
    if (Date.now() - started > PRE_EARNINGS.budgetMs) break;
    const news = await data.getNews([f.r.symbol], new Date(deps.now.getTime() - PRE_EARNINGS.fade.days * 86400_000), deps.now, 50).catch(() => null);
    if (!news) continue;
    const mine = news.filter((n) => n.symbols.length <= 3 || n.symbols[0] === f.r.symbol);
    for (const l of [joltLeg(f.jolt, f.jolt ? headlinesNear(mine, f.jolt.date) : null), fadeLeg(mine, f.b)]) if (l) f.legs.push(l);
  }

  // No filing comparison on file: read the latest report against a year earlier by code, for a few of the stocks that slid or dropped.
  const ua = deps.env.SEC_USER_AGENT?.trim();
  let reads = 0;
  if (ua) {
    const need = found.filter((f) => f.legs.some((l) => l.kind === "slide" || l.kind === "jolt") && !stored.has(f.r.symbol)).sort((a, b) => (b.r.marketCap ?? 0) - (a.r.marketCap ?? 0));
    let ciks: Map<string, string> | null = null;
    for (const f of need) {
      const key = `pre-earnings:filing:${f.r.symbol}`;
      let note = (await store.cacheGet<MechNote>(key).catch(() => null))?.data ?? null;
      if ((!note || Date.parse(note.at) < deps.now.getTime() - 20 * 86400_000) && reads < PRE_EARNINGS.readsPerRun && Date.now() - started < PRE_EARNINGS.budgetMs) {
        reads++;
        try {
          ciks ??= new Map((await import("../sources/edgar").then(({ secTickerList }) => secTickerList(ua, deps.fetchImpl))).map((t) => [t.ticker, t.cik]));
          const cik = ciks.get(f.r.symbol);
          const got = cik ? await import("./filing-diff").then(({ mechanicalLatest }) => mechanicalLatest(cik, ua, deps.fetchImpl)) : null;
          note = { at: deps.now.toISOString(), form: got?.latest.form ?? "", filed: got?.latest.filed ?? "", url: got?.latest.url ?? "", accession: got?.latest.accession, flag: null, negatives: [], shifts: got?.m.shifts ?? [] };
          await store.cachePut(key, note).catch(() => undefined);
        } catch (e) { console.warn(`pre-earnings filing ${f.r.symbol}: ${e instanceof Error ? e.message : e}`); }
      }
      const l = note?.filed ? filingLeg(note, today) : null;
      if (l) f.legs.push(l);
    }
  }

  // Keep every screened stock. Signs never shrink once seen (a flag that was sent stays on the record), and the flag is sticky.
  const payload = found.map((f) => ({ symbol: f.r.symbol, report_date: f.r.reportDate, name: f.r.name, timing: f.r.timing, market_cap: f.r.marketCap, legs: f.legs, n_legs: f.legs.length, flagged: f.legs.length >= PRE_EARNINGS.flagAt, move30: f.slide?.pct ?? null, spy30: f.slide?.spyPct ?? null }));
  await q(
    `INSERT INTO pre_earnings (symbol, report_date, name, timing, market_cap, legs, n_legs, flagged, first_flagged_at, move30, spy30, screened_at)
     SELECT x.symbol, x.report_date, x.name, x.timing, x.market_cap, x.legs, x.n_legs, x.flagged, CASE WHEN x.flagged THEN $2::timestamptz END, x.move30, x.spy30, $2::timestamptz
     FROM jsonb_to_recordset($1::jsonb) AS x(symbol text, report_date date, name text, timing text, market_cap double precision, legs jsonb, n_legs int, flagged boolean, move30 double precision, spy30 double precision)
     ON CONFLICT (symbol, report_date) DO UPDATE SET name = EXCLUDED.name, timing = EXCLUDED.timing, market_cap = EXCLUDED.market_cap, move30 = EXCLUDED.move30, spy30 = EXCLUDED.spy30, screened_at = EXCLUDED.screened_at,
       legs = CASE WHEN EXCLUDED.n_legs >= pre_earnings.n_legs THEN EXCLUDED.legs ELSE pre_earnings.legs END,
       n_legs = GREATEST(EXCLUDED.n_legs, pre_earnings.n_legs),
       flagged = pre_earnings.flagged OR EXCLUDED.flagged,
       first_flagged_at = COALESCE(pre_earnings.first_flagged_at, EXCLUDED.first_flagged_at)
     WHERE pre_earnings.measured_at IS NULL`,
    [JSON.stringify(payload), deps.now.toISOString()],
  );

  const flagged = found.filter((f) => f.legs.length >= PRE_EARNINGS.flagAt).sort((a, b) => b.legs.length - a.legs.length || (b.r.marketCap ?? 0) - (a.r.marketCap ?? 0));
  const pushed = await alerts(flagged.map((f) => ({ symbol: f.r.symbol, name: f.r.name, reportDate: f.r.reportDate, timing: f.r.timing, legs: f.legs })), deps.env, today, deps.fetchImpl).catch(() => 0);
  const record = await preEarningsRecord().catch(() => scoreTable([]));
  return `pre-earnings: ${symbols.length} stocks reporting in the next ${days.length} sessions screened ($${PRE_EARNINGS.minCapUsd / 1e6}M+); ${flagged.length} flagged${flagged.length ? ` (${flagged.slice(0, 8).map((f) => `${f.r.symbol} ${f.legs.map((l) => l.kind).join("+")}`).join(", ")})` : ""}; ${found.filter((f) => f.legs.length === 1).length} with one sign; ${wantNews.length} checked for headlines, ${reads} filings read; ${pushed} pushed; ${measured} past reports measured · record: ${scoreLine(record)}`;
}

/** Push new flags, your own stocks first, a few a day at most. */
async function alerts(flagged: Array<Pick<PreEarningsRow, "symbol" | "name" | "reportDate" | "timing" | "legs">>, env: NodeJS.ProcessEnv, today: string, fetchImpl?: typeof fetch): Promise<number> {
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured(env) || !flagged.length) return 0;
  const [cards, watch] = await Promise.all([store.cardsSince(120).catch(() => []), store.watchlist("active").catch(() => [])]);
  const mine = new Set([...cards.flatMap((c) => c.card.tickers.map((t) => t.symbol)), ...watch.flatMap((w) => w.tickers)]);
  const base = env.DASHBOARD_URL?.replace(/\/$/, "");
  const countKey = `pre-earnings:pushed:${today}`;
  let sent = (await store.cacheGet<{ n: number }>(countKey).catch(() => null))?.data?.n ?? 0, n = 0;
  for (const f of [...flagged].sort((a, b) => Number(mine.has(b.symbol)) - Number(mine.has(a.symbol)))) {
    if (sent >= PRE_EARNINGS.pushPerDay) break;
    const title = `${f.symbol} reports ${f.reportDate.slice(5)} with ${f.legs.length} warning signs${mine.has(f.symbol) ? " (your stock)" : ""}`;
    if (!(await store.claimNotification(`pre-earnings:${f.symbol}:${f.reportDate}`, title))) continue;
    await sendPush({ title, message: `${f.name ? `${f.name}. ` : ""}${f.legs.map((l) => l.text).join("; ")}. A reason to look, not a call: the screen is new and unproven.`.slice(0, 480), tags: ["warning"], priority: mine.has(f.symbol) ? 4 : 3, click: base ? `${base}/calendar#pre-earnings` : undefined }, env, fetchImpl);
    await store.cachePut(countKey, { n: ++sent }).catch(() => undefined);
    n++;
  }
  return n;
}
