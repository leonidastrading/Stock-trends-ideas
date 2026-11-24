/**
 * Do stocks keep falling after an analyst downgrade? A look-back over the scout's ~390 large and mid caps, 2019 to
 * mid-2025, on data the scout already has: Alpaca's news history (Benzinga's rating headlines, "Morgan Stanley
 * Downgrades Nike to Equal-Weight") and daily prices. No model is called.
 *
 * For every rating headline: the reaction day (the first session whose close came after the headline) and the
 * stock's return against SPY over the next 5, 10, 20 and 60 sessions, from the reaction-day close and (the tradable
 * version) from the next open. Upgrades are measured the same way, as the comparison.
 *
 * Reading six years of headlines is tens of thousands of requests, so it runs as a paced background job in
 * 4-minute passes that pick up where the last one stopped, and is done once.
 *
 * Limits, stated on the page: the list of stocks is today's, so companies that fell out of it are missing (which
 * hides some of the worst outcomes); and a rating change is only seen when its headline has the usual wording.
 */
import { UNIVERSE } from "@/config/universe";
import type { DailyBar, MarketData } from "../alpaca";
import { query as q } from "../db";
import { toEt } from "../time";
import { TOP_BROKERS } from "./drift";
import * as store from "./store";

export const RATING_STUDY = {
  start: "2019-01-01", end: "2025-06-30",
  /** Prices run past the last headline so its 60-session return exists. */
  barsStart: "2018-12-01", barsEnd: "2025-10-15",
  horizons: [5, 10, 20, 60] as const,
  batch: 20, passMs: 225_000, pauseMs: 250, minPrice: 5,
};

/** Every stock in the study, in a fixed order. */
export const studySymbols = (): string[] => [...new Set(Object.values(UNIVERSE).flat())].sort();

export interface RatingAction { kind: "downgrade" | "upgrade"; broker: string; to: string; strength: "strong" | "mild"; topBroker: boolean }

/**
 * Pure: a rating-change headline in the wires' usual form ("<Broker> Downgrades <Company> to <Rating>…"), or null.
 * Strong: a downgrade to Sell / Underperform / Underweight / Reduce, an upgrade to Buy / Outperform / Overweight.
 * Round-ups ("Benzinga's Top Upgrades, Downgrades…") and price commentary do not have this form.
 */
export function ratingAction(headline: string): RatingAction | null {
  const m = /^(.{2,45}?)\s+(Downgrades|Upgrades)\s+(.{2,90}?)\s+to\s+([A-Za-z][A-Za-z -]{2,24})/.exec(headline.trim());
  if (!m || /^(benzinga|top |these |here|why |\d)/i.test(m[1])) return null;
  const kind = m[2] === "Downgrades" ? "downgrade" as const : "upgrade" as const;
  const to = m[4].replace(/\s+(lowers|raises|maintains|announces|adjusts|cuts|boosts|sets|keeps|price|pt|target|and|with|from|on|as|after|amid)\b.*$/i, "").trim();
  const strong = kind === "downgrade" ? /sell|underperform|underweight|reduce/i.test(to) : /buy|outperform|overweight|accumulate|positive/i.test(to);
  return { kind, broker: m[1].trim(), to, strength: strong ? "strong" : "mild", topBroker: TOP_BROKERS.test(m[1]) };
}

/** Pure: the reaction day: the first session whose close came after the headline (before 4 PM ET: that day, if it is a session). */
export function reactionDay(ts: string, sessions: string[]): string | null {
  const et = toEt(new Date(ts));
  return sessions.find((d) => (et.minutes < 16 * 60 ? d >= et.date : d > et.date)) ?? null;
}

export interface EventReturns { reaction: number | null; x: Record<number, number | null>; o: Record<number, number | null>; price: number }
const pct = (a: number, b: number) => Math.round((a / b - 1) * 10000) / 100;

/**
 * Pure: what the stock did against SPY: on the reaction day (close to close), and over each horizon from the
 * reaction-day close (x) and from the next session's open (o). Percent; null where the prices do not reach.
 */
export function eventReturns(bars: DailyBar[], spy: Map<string, DailyBar>, day0: string, horizons: readonly number[] = RATING_STUDY.horizons): EventReturns | null {
  const i = bars.findIndex((b) => b.date === day0);
  if (i < 1) return null;
  const s0 = spy.get(day0), sPrev = spy.get(bars[i - 1].date);
  const reaction = s0 && sPrev ? Math.round((pct(bars[i].c, bars[i - 1].c) - pct(s0.c, sPrev.c)) * 100) / 100 : null;
  const x: Record<number, number | null> = {}, o: Record<number, number | null> = {};
  const next = bars[i + 1], sNext = next ? spy.get(next.date) : undefined;
  for (const h of horizons) {
    const end = bars[i + h], sEnd = end ? spy.get(end.date) : undefined;
    x[h] = end && sEnd && s0 ? Math.round((pct(end.c, bars[i].c) - pct(sEnd.c, s0.c)) * 100) / 100 : null;
    o[h] = end && sEnd && next && sNext && next.o > 0 && sNext.o > 0 ? Math.round((pct(end.c, next.o) - pct(sEnd.c, sNext.o)) * 100) / 100 : null;
  }
  return { reaction, x, o, price: bars[i].c };
}

// ---------------------------------------------------------------- the paced job

export interface StudyState { batch: number; token: string | null; done: boolean; pages: number; headlines: number; events: number; at: string | null; startedAt: string; updatedAt: string; error: string | null }
const STATE = "rating-study:state", SPY = "rating-study:spy";

export async function studyState(): Promise<StudyState | null> {
  return (await store.cacheGet<StudyState>(STATE).catch(() => null))?.data ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One pass: read headlines from where the last pass stopped until the time is up. Returns a line for the log, and whether there is more. */
export async function runRatingStudy(data: MarketData | null, deadline = Date.now() + RATING_STUDY.passMs): Promise<{ line: string; more: boolean }> {
  if (!data?.getNewsPage) return { line: "rating study: news stream not configured (Alpaca keys)", more: false };
  const now = () => new Date().toISOString();
  const st: StudyState = (await studyState()) ?? { batch: 0, token: null, done: false, pages: 0, headlines: 0, events: 0, at: null, startedAt: now(), updatedAt: now(), error: null };
  if (st.done) return { line: "rating study: done", more: false };
  if (!(await store.tryLock("lock:rating-study:run", 5))) return { line: "rating study: another pass is running", more: false };
  const all = studySymbols(), batches = Math.ceil(all.length / RATING_STUDY.batch);
  const save = () => store.cachePut(STATE, { ...st, updatedAt: now() } satisfies StudyState).catch(() => undefined);
  try {
    // SPY's prices are read once and kept (the sessions and the benchmark for every event).
    let spyBars = (await store.cacheGet<DailyBar[]>(SPY).catch(() => null))?.data ?? null;
    if (!spyBars?.length) {
      spyBars = await data.getDailyBars(["SPY"], RATING_STUDY.barsStart, RATING_STUDY.barsEnd, { feed: "sip", adjustment: "all" });
      await store.cachePut(SPY, spyBars).catch(() => undefined);
    }
    const spy = new Map(spyBars.map((b) => [b.date, b]));
    const sessions = spyBars.map((b) => b.date).sort();
    const from = new Date(`${RATING_STUDY.start}T00:00:00Z`), to = new Date(`${RATING_STUDY.end}T23:59:59Z`);

    while (st.batch < batches && Date.now() < deadline) {
      const syms = all.slice(st.batch * RATING_STUDY.batch, (st.batch + 1) * RATING_STUDY.batch);
      const inBatch = new Set(syms);
      const bars = await data.getDailyBars(syms, RATING_STUDY.barsStart, RATING_STUDY.barsEnd, { feed: "sip", adjustment: "all" });
      const by = new Map<string, DailyBar[]>();
      for (const b of bars) by.set(b.symbol, [...(by.get(b.symbol) ?? []), b]);
      for (const v of by.values()) v.sort((a, b) => a.date.localeCompare(b.date));
      let finished = false;
      while (Date.now() < deadline) {
        const page = await data.getNewsPage(syms, from, to, st.token);
        st.pages++; st.headlines += page.items.length;
        for (const n of page.items) {
          const act = ratingAction(n.headline);
          // A rating headline names one company: skip anything tagged with several, and symbols outside this batch.
          const sym = n.symbols.length <= 2 ? n.symbols.find((s) => inBatch.has(s)) : undefined;
          if (!act || !sym) continue;
          const day0 = reactionDay(n.ts, sessions);
          const r = day0 ? eventReturns(by.get(sym) ?? [], spy, day0) : null;
          if (!day0 || !r || r.price < RATING_STUDY.minPrice) continue;
          const added = await q(
            `INSERT INTO rating_study_events (symbol, day, kind, broker, strength, top_broker, headline, news_at, reaction, x5, x10, x20, x60, o20, o60) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING symbol`,
            [sym, day0, act.kind, act.broker.slice(0, 80), act.strength, act.topBroker, n.headline.slice(0, 300), n.ts, r.reaction, r.x[5], r.x[10], r.x[20], r.x[60], r.o[20], r.o[60]]);
          st.events += added.length;
        }
        if (page.items.length) st.at = page.items.at(-1)!.ts;
        st.token = page.next;
        if (!page.next) { finished = true; break; }
        if (st.pages % 10 === 0) await save();
        await sleep(RATING_STUDY.pauseMs);
      }
      if (!finished) break; // out of time inside this batch: the token says where to go on
      st.batch++; st.token = null; st.at = null;
      await save();
    }
    st.done = st.batch >= batches;
    st.error = null;
    await save();
    return { line: `rating study: ${st.done ? "done" : `batch ${st.batch + 1} of ${batches}${st.at ? `, at ${st.at.slice(0, 10)}` : ""}`} · ${st.pages.toLocaleString("en-US")} pages, ${st.headlines.toLocaleString("en-US")} headlines, ${st.events.toLocaleString("en-US")} rating changes`, more: !st.done };
  } catch (err) {
    st.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    // A page token the server no longer accepts: start this batch again (rows already saved are kept, not doubled).
    if (/page_token|40[04]|422/i.test(st.error)) st.token = null;
    await save();
    return { line: `rating study: stopped (${st.error}); it tries again on the next pass`, more: false };
  } finally {
    await store.unlock("lock:rating-study:run").catch(() => undefined);
  }
}

// ---------------------------------------------------------------- results

/** One rating change on one stock on one day (several brokers the same day count once). */
export interface StudyEvent { symbol: string; day: string; kind: "downgrade" | "upgrade"; strong: boolean; topBroker: boolean; brokers: number; reaction: number | null; x: Record<number, number | null>; o: Record<number, number | null> }

export async function studyEvents(): Promise<StudyEvent[]> {
  const rows = await q(`SELECT symbol, day::text AS day, kind, bool_or(strength = 'strong') AS strong, bool_or(top_broker) AS top, count(*)::int AS brokers,
    max(reaction) AS reaction, max(x5) AS x5, max(x10) AS x10, max(x20) AS x20, max(x60) AS x60, max(o20) AS o20, max(o60) AS o60
    FROM rating_study_events GROUP BY symbol, day, kind`);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({ symbol: String(r.symbol), day: String(r.day).slice(0, 10), kind: r.kind as StudyEvent["kind"], strong: !!r.strong, topBroker: !!r.top, brokers: Number(r.brokers), reaction: n(r.reaction), x: { 5: n(r.x5), 10: n(r.x10), 20: n(r.x20), 60: n(r.x60) }, o: { 20: n(r.o20), 60: n(r.o60) } }));
}

export interface Stat { n: number; mean: number | null; median: number | null; negShare: number | null; t: number | null }

/** Pure: mean, median, share below zero and t-statistic of a list of excess returns (percent). */
export function stat(values: Array<number | null>): Stat {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, mean: null, median: null, negShare: null, t: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length, mid = Math.floor(xs.length / 2);
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { n: xs.length, mean: r2(mean), median: r2(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2), negShare: Math.round((xs.filter((v) => v < 0).length / xs.length) * 100), t: sd > 0 ? r2(mean / (sd / Math.sqrt(xs.length))) : null };
}

export interface StudyRow { label: string; n: number; reaction: Stat; x5: Stat; x10: Stat; x20: Stat; x60: Stat; o20: Stat; o60: Stat }

/** Pure: one line of the results table. */
export function studyRow(label: string, es: StudyEvent[]): StudyRow {
  return { label, n: es.length, reaction: stat(es.map((e) => e.reaction)), x5: stat(es.map((e) => e.x[5])), x10: stat(es.map((e) => e.x[10])), x20: stat(es.map((e) => e.x[20])), x60: stat(es.map((e) => e.x[60])), o20: stat(es.map((e) => e.o[20])), o60: stat(es.map((e) => e.o[60])) };
}

/** Pure: the table: downgrades (all, by strength, broker, reaction size, clusters, period), then upgrades as the comparison. */
export function studyTable(events: StudyEvent[]): StudyRow[] {
  const d = events.filter((e) => e.kind === "downgrade"), u = events.filter((e) => e.kind === "upgrade");
  return [
    studyRow("All downgrades", d),
    studyRow("To Sell / Underperform / Underweight", d.filter((e) => e.strong)),
    studyRow("To Neutral / Hold / Equal-Weight", d.filter((e) => !e.strong)),
    studyRow("From a large broker", d.filter((e) => e.topBroker)),
    studyRow("Two or more brokers the same day", d.filter((e) => e.brokers >= 2)),
    studyRow("Stock fell 5%+ on the day (vs SPY)", d.filter((e) => e.reaction !== null && e.reaction <= -5)),
    studyRow("Stock fell less than 5% on the day", d.filter((e) => e.reaction !== null && e.reaction > -5)),
    studyRow("2019-2021", d.filter((e) => e.day < "2022-01-01")),
    studyRow("2022-2025", d.filter((e) => e.day >= "2022-01-01")),
    studyRow("All upgrades (comparison)", u),
    studyRow("Upgrades to Buy / Outperform / Overweight", u.filter((e) => e.strong)),
  ];
}
