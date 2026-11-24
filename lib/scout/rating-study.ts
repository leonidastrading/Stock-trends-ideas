/**
 * Do stocks keep falling after an analyst downgrade? A look-back over the scout's ~390 large and mid caps from 2019,
 * with no model: every rating change in Financial Modeling Prep's grades history (FMP_API_KEY: the broker, the old
 * and new rating, and whether it was an upgrade or a downgrade, back to 2012) against Alpaca's daily prices.
 *
 * For every rating change: the reaction day (the day it is dated, or the next session) and the stock's return
 * against SPY over the next 5, 10, 20 and 60 sessions, from the reaction-day close and from the next session's
 * open. Upgrades are measured the same way, as the comparison.
 *
 * The grades carry a date but no time. A change published after the close shows its fall the next day, which the
 * from-the-close numbers would count as drift. The from-the-next-open numbers do not have that problem (whenever the
 * news came, the entry is after it), so they are the ones to trust.
 *
 * One request per stock, paced, in passes that pick up where the last one stopped, and never more than
 * `perDay` requests a day (the key's daily allowance is shared with the cards' Financials). Done once.
 *
 * (Alpaca's news history was the first plan: it holds nothing before May 2026, so it cannot answer this.)
 *
 * Limits, stated on the page: the list of stocks is today's, so companies that fell out of it are missing (which
 * hides some of the worst outcomes), and the history is what the provider has on file today.
 */
import { UNIVERSE } from "@/config/universe";
import type { DailyBar, MarketData } from "../alpaca";
import { query as q } from "../db";
import { addDays, toEt } from "../time";
import { TOP_BROKERS } from "./drift";
import * as store from "./store";

export const RATING_STUDY = {
  start: "2019-01-01",
  /** Prices start before the first event, for its reaction day. */
  barsStart: "2018-12-01",
  /** The last event needs 60 sessions of prices after it: about 90 days before today. */
  tailDays: 90,
  horizons: [5, 10, 20, 60] as const,
  chunk: 20, passMs: 225_000, pauseMs: 300, minPrice: 5,
  /** Requests to Financial Modeling Prep a day, at most (its free allowance is about 250, shared with the cards). */
  perDay: 200,
};

/** Every stock in the study, in a fixed order. */
export const studySymbols = (): string[] => [...new Set(Object.values(UNIVERSE).flat())].sort();

export interface RatingAction { kind: "downgrade" | "upgrade"; broker: string; to: string; strength: "strong" | "mild"; topBroker: boolean }

/**
 * Pure: one row of the grades history as a rating change, or null (a rating kept or a first rating is not one).
 * Strong: a downgrade to Sell / Underperform / Underweight / Reduce, an upgrade to Buy / Outperform / Overweight.
 */
export function gradeAction(row: Record<string, unknown>): RatingAction | null {
  const action = String(row.action ?? "").toLowerCase();
  const kind = /^down/.test(action) ? "downgrade" as const : /^up/.test(action) ? "upgrade" as const : null;
  const broker = String(row.gradingCompany ?? "").trim();
  if (!kind || !broker) return null;
  const to = String(row.newGrade ?? "").trim();
  const strong = kind === "downgrade" ? /sell|underperform|underweight|reduce|negative/i.test(to) : /buy|outperform|overweight|accumulate|positive/i.test(to);
  return { kind, broker, to, strength: strong ? "strong" : "mild", topBroker: TOP_BROKERS.test(broker) };
}

/** Pure: the reaction day for a change dated `date`: that day when it is a session, else the next one. */
export function reactionDay(date: string, sessions: string[]): string | null {
  return sessions.find((d) => d >= date) ?? null;
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

export interface StudyState {
  /** The next stock to read (an index into studySymbols). */
  next: number; done: boolean; events: number; rows: number;
  /** Stocks the provider had nothing for (or refused). */
  empty: string[];
  /** Requests made today (US Eastern), for the daily allowance. */
  day: string; calls: number;
  /** The last event date the prices can follow for 60 sessions. */
  end: string; startedAt: string; updatedAt: string; error: string | null;
}
const STATE = "rating-study:fmp", SPY = "rating-study:spy2";

export async function studyState(): Promise<StudyState | null> {
  return (await store.cacheGet<StudyState>(STATE).catch(() => null))?.data ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One stock's grades history. null when the provider has none for it (402/403/404); throws on anything else (the limit, an outage). */
async function grades(symbol: string, key: string, fetchImpl: typeof fetch): Promise<Array<Record<string, unknown>> | null> {
  const res = await fetchImpl(`https://financialmodelingprep.com/stable/grades?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if ([402, 403, 404].includes(res.status)) return null;
  if (!res.ok) throw new Error(`Financial Modeling Prep ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new Error(`Financial Modeling Prep: ${JSON.stringify(body ?? "no reply").slice(0, 120)}`);
  return body as Array<Record<string, unknown>>;
}

/** One pass: read stocks from where the last pass stopped until the time, or the day's allowance, is up. A line for the log, and whether to go straight on. */
export async function runRatingStudy(data: MarketData | null, deadline = Date.now() + RATING_STUDY.passMs, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, nowDate = new Date()): Promise<{ line: string; more: boolean }> {
  const key = env.FMP_API_KEY?.trim();
  if (!data || !key) return { line: "rating study: needs Alpaca prices and FMP_API_KEY", more: false };
  const now = () => new Date().toISOString();
  const today = toEt(nowDate).date;
  const st: StudyState = (await studyState()) ?? { next: 0, done: false, events: 0, rows: 0, empty: [], day: today, calls: 0, end: addDays(today, -RATING_STUDY.tailDays), startedAt: now(), updatedAt: now(), error: null };
  if (st.done) return { line: "rating study: done", more: false };
  if (st.day !== today) { st.day = today; st.calls = 0; }
  if (st.calls >= RATING_STUDY.perDay) return { line: "rating study: waiting (today's allowance of requests is used; it goes on tomorrow)", more: false };
  if (!(await store.tryLock("lock:rating-study:run", 5))) return { line: "rating study: another pass is running", more: false };
  const all = studySymbols();
  const save = () => store.cachePut(STATE, { ...st, updatedAt: now() } satisfies StudyState).catch(() => undefined);
  try {
    // SPY's prices are read once and kept (the sessions and the benchmark for every event).
    let spyBars = (await store.cacheGet<DailyBar[]>(SPY).catch(() => null))?.data ?? null;
    if (!spyBars?.length) {
      spyBars = await data.getDailyBars(["SPY"], RATING_STUDY.barsStart, today, { feed: "sip", adjustment: "all" });
      await store.cachePut(SPY, spyBars).catch(() => undefined);
    }
    const spy = new Map(spyBars.map((b) => [b.date, b]));
    const sessions = spyBars.map((b) => b.date).sort();
    let bars = new Map<string, DailyBar[]>();
    let chunkOf = -1;

    while (st.next < all.length && Date.now() < deadline && st.calls < RATING_STUDY.perDay) {
      const sym = all[st.next];
      // Prices for this stock and its neighbours in the list, one request per twenty stocks.
      const c = Math.floor(st.next / RATING_STUDY.chunk);
      if (c !== chunkOf) {
        const got = await data.getDailyBars(all.slice(c * RATING_STUDY.chunk, (c + 1) * RATING_STUDY.chunk), RATING_STUDY.barsStart, today, { feed: "sip", adjustment: "all" });
        bars = new Map();
        for (const b of got) bars.set(b.symbol, [...(bars.get(b.symbol) ?? []), b]);
        for (const v of bars.values()) v.sort((a, b) => a.date.localeCompare(b.date));
        chunkOf = c;
      }
      st.calls++;
      const rows = await grades(sym, key, fetchImpl);
      if (!rows?.length) st.empty.push(sym);
      for (const r of rows ?? []) {
        const date = String(r.date ?? "").slice(0, 10), act = gradeAction(r);
        if (!act || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < RATING_STUDY.start || date > st.end) continue;
        st.rows++;
        const day0 = reactionDay(date, sessions);
        const ret = day0 ? eventReturns(bars.get(sym) ?? [], spy, day0) : null;
        if (!day0 || !ret || ret.price < RATING_STUDY.minPrice) continue;
        const note = `${act.broker} ${act.kind}s ${sym} to ${act.to || "?"}${r.previousGrade ? ` from ${String(r.previousGrade)}` : ""}`;
        const added = await q(
          `INSERT INTO rating_study_events (symbol, day, kind, broker, strength, top_broker, headline, news_at, reaction, x5, x10, x20, x60, o5, o10, o20, o60) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING symbol`,
          [sym, day0, act.kind, act.broker.slice(0, 80), act.strength, act.topBroker, note.slice(0, 300), `${date}T12:00:00Z`, ret.reaction, ret.x[5], ret.x[10], ret.x[20], ret.x[60], ret.o[5], ret.o[10], ret.o[20], ret.o[60]]);
        st.events += added.length;
      }
      st.next++;
      if (st.next % 5 === 0) await save();
      if (!process.env.VITEST) await sleep(RATING_STUDY.pauseMs); // paced for the provider; tests do not wait
    }
    st.done = st.next >= all.length;
    st.error = null;
    await save();
    const waiting = !st.done && st.calls >= RATING_STUDY.perDay;
    return { line: `rating study: ${st.done ? "done" : `${st.next} of ${all.length} stocks${waiting ? " (today's allowance used; it goes on tomorrow)" : ""}`} · ${st.rows.toLocaleString("en-US")} rating changes read, ${st.events.toLocaleString("en-US")} measured${st.empty.length ? `, ${st.empty.length} stocks with no history` : ""}`, more: !st.done && !waiting };
  } catch (err) {
    st.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    // The provider's limit: nothing more today.
    if (/\b429\b|limit/i.test(st.error)) st.calls = RATING_STUDY.perDay;
    await save();
    return { line: `rating study: stopped at ${all[st.next] ?? "?"} (${st.error}); it tries again on the next pass`, more: false };
  } finally {
    await store.unlock("lock:rating-study:run").catch(() => undefined);
  }
}

// ---------------------------------------------------------------- results

/** One rating change on one stock on one day (several brokers the same day count once). */
export interface StudyEvent { symbol: string; day: string; kind: "downgrade" | "upgrade"; strong: boolean; topBroker: boolean; brokers: number; reaction: number | null; x: Record<number, number | null>; o: Record<number, number | null> }

export async function studyEvents(): Promise<StudyEvent[]> {
  const rows = await q(`SELECT symbol, day::text AS day, kind, bool_or(strength = 'strong') AS strong, bool_or(top_broker) AS top, count(*)::int AS brokers,
    max(reaction) AS reaction, max(x5) AS x5, max(x10) AS x10, max(x20) AS x20, max(x60) AS x60, max(o5) AS o5, max(o10) AS o10, max(o20) AS o20, max(o60) AS o60
    FROM rating_study_events GROUP BY symbol, day, kind`);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({ symbol: String(r.symbol), day: String(r.day).slice(0, 10), kind: r.kind as StudyEvent["kind"], strong: !!r.strong, topBroker: !!r.top, brokers: Number(r.brokers), reaction: n(r.reaction), x: { 5: n(r.x5), 10: n(r.x10), 20: n(r.x20), 60: n(r.x60) }, o: { 5: n(r.o5), 10: n(r.o10), 20: n(r.o20), 60: n(r.o60) } }));
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

export interface StudyRow { label: string; n: number; reaction: Stat; x5: Stat; x10: Stat; x20: Stat; x60: Stat; o5: Stat; o10: Stat; o20: Stat; o60: Stat }

/** Pure: one line of the results table. */
export function studyRow(label: string, es: StudyEvent[]): StudyRow {
  return { label, n: es.length, reaction: stat(es.map((e) => e.reaction)), x5: stat(es.map((e) => e.x[5])), x10: stat(es.map((e) => e.x[10])), x20: stat(es.map((e) => e.x[20])), x60: stat(es.map((e) => e.x[60])), o5: stat(es.map((e) => e.o[5])), o10: stat(es.map((e) => e.o[10])), o20: stat(es.map((e) => e.o[20])), o60: stat(es.map((e) => e.o[60])) };
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
    studyRow("2022-2023", d.filter((e) => e.day >= "2022-01-01" && e.day < "2024-01-01")),
    studyRow("2024-2026", d.filter((e) => e.day >= "2024-01-01")),
    studyRow("All upgrades (comparison)", u),
    studyRow("Upgrades to Buy / Outperform / Overweight", u.filter((e) => e.strong)),
  ];
}
