/**
 * Dashboard panels for the Digest page. Each panel is cached in the database
 * (dashboard_cache) and refreshed when older than its max age, so a page view
 * makes at most a few outside calls and falls back to the last good copy.
 */
import { UNIVERSE } from "@/config/universe";
import { type DailyBar, type MarketData } from "../alpaca";
import { secTickerList } from "../sources/edgar";
import { addDays, toEt } from "../time";
import { spikeScore } from "../scout/chatter";
import * as store from "../scout/store";
import { contractorTicker, earningsOn, recentContracts, treasuryYields, vix, type EarningsRow } from "./sources";

export interface Panel<T> { data: T | null; updatedAt: string | null; error: string | null }

/** Cached fetch: fresh copy if younger than maxAgeMin, else refetch (with a time limit), else the stale copy. */
export async function panel<T>(key: string, maxAgeMin: number, fetcher: () => Promise<T>, timeoutMs = 9000): Promise<Panel<T>> {
  const cached = await store.cacheGet<T>(key).catch(() => null);
  if (cached && Date.now() - Date.parse(cached.updatedAt) < maxAgeMin * 60000) return { data: cached.data, updatedAt: cached.updatedAt, error: null };
  try {
    const data = await Promise.race([fetcher(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), timeoutMs))]);
    await store.cachePut(key, data).catch(() => undefined);
    return { data, updatedAt: new Date().toISOString(), error: null };
  } catch (err) {
    return { data: cached?.data ?? null, updatedAt: cached?.updatedAt ?? null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- market row

export interface MarketRow { label: string; value: string; changePct: number | null }

const pctChange = (bars: DailyBar[]) => {
  const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  return s.length >= 2 ? (s[s.length - 1].c / s[s.length - 2].c - 1) * 100 : null;
};

export async function marketRows(data: MarketData | null, now: Date): Promise<MarketRow[]> {
  const today = toEt(now).date;
  const rows: MarketRow[] = [];
  if (data) {
    const etfs: Array<[string, string]> = [["SPY", "S&P 500 (SPY)"], ["QQQ", "Nasdaq 100 (QQQ)"], ["IWM", "Russell 2000 (IWM)"], ["USO", "Oil (USO)"]];
    const bars = await data.getDailyBars(etfs.map((e) => e[0]), addDays(today, -10), today);
    for (const [sym, label] of etfs) {
      const b = bars.filter((x) => x.symbol === sym);
      const last = b.slice().sort((a, c) => a.date.localeCompare(c.date)).at(-1);
      rows.push({ label, value: last ? `$${last.c.toFixed(2)}` : "—", changePct: pctChange(b) });
    }
  }
  const y = await treasuryYields(Number(today.slice(0, 4))).catch(() => null);
  if (y) {
    rows.push({ label: "10-year Treasury", value: `${y.y10.toFixed(2)}%`, changePct: y.prev10 !== null ? Math.round((y.y10 - y.prev10) * 100) / 100 : null });
    rows.push({ label: "30-year Treasury", value: `${y.y30.toFixed(2)}%`, changePct: y.prev30 !== null ? Math.round((y.y30 - y.prev30) * 100) / 100 : null });
  }
  const v = await vix().catch(() => null);
  if (v) rows.push({ label: "VIX", value: v.last.toFixed(1), changePct: v.changePct });
  return rows;
}

// --------------------------------------------------------------- earnings

export interface EarningsPanel { total: number; rows: EarningsRow[] }

export function businessDaysFrom(today: string, n: number): string[] {
  const out: string[] = [];
  for (let d = today; out.length < n; d = addDays(d, 1)) if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) out.push(d);
  return out;
}

export async function earningsPanel(now: Date): Promise<EarningsPanel> {
  const all: EarningsRow[] = [];
  for (const d of businessDaysFrom(toEt(now).date, 5)) all.push(...(await earningsOn(d).catch(() => [])));
  if (!all.length) throw new Error("earnings calendar returned nothing");
  // Confirmed dates replace the estimate on any symbol the scout tracks.
  for (const r of all) {
    await store.confirmEarnings(r.symbol, r.date, `confirmed (Nasdaq calendar${r.time ? `, ${r.time}` : ""})`).catch(() => undefined);
  }
  return { total: all.length, rows: all.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, 12) };
}

// -------------------------------------------------------------- contracts

export interface ContractRow { ticker: string; recipient: string; agency: string; amount: number; date: string; description: string }

export async function contractsPanel(now: Date, ua: string | undefined): Promise<ContractRow[]> {
  const today = toEt(now).date;
  const txs = await recentContracts(addDays(today, -10), today);
  const sec = ua ? await secTickerList(ua).catch(() => []) : [];
  const out: ContractRow[] = [];
  const seen = new Set<string>();
  for (const t of txs) {
    const ticker = contractorTicker(t.recipient, sec);
    if (!ticker || seen.has(t.awardId + ticker)) continue;
    seen.add(t.awardId + ticker);
    out.push({ ticker, recipient: t.recipient, agency: t.agency, amount: t.amount, date: t.date, description: t.description.slice(0, 140) });
  }
  return out.slice(0, 12);
}

// ------------------------------------------------------------------- buzz

export interface BuzzRow { symbol: string; score: number; parts: string }

/** Pure: buzz out of 20 = chatter spike (0-8) + news against its usual pace (0-6) + Stocktwits trending (0-6). */
export function buzzScore(i: { chatterZ: number | null; news: number | null; newsAvg: number | null; trendingRank: number | null }): { score: number; parts: string } {
  const c = i.chatterZ === null ? 0 : Math.round(Math.max(0, Math.min(4, i.chatterZ)) * 2);
  const ratio = i.news !== null && i.news >= 3 ? i.news / Math.max(i.newsAvg ?? 1, 1) : 0;
  const n = ratio >= 4 ? 6 : ratio >= 2.5 ? 4 : ratio >= 1.5 ? 2 : 0;
  const t = i.trendingRank !== null && i.trendingRank <= 10 ? 6 : i.trendingRank !== null && i.trendingRank <= 30 ? 3 : 0;
  return { score: c + n + t, parts: `chatter ${c}/8 · news ${n}/6 · trending ${t}/6` };
}

export async function buzzPanel(): Promise<BuzzRow[]> {
  const rows = await store.buzzInputs();
  return rows
    .map((r) => ({ symbol: r.symbol, ...buzzScore({ chatterZ: r.history.length ? spikeScore(r.history, r.perHour)?.z ?? null : null, news: r.news, newsAvg: r.newsAvg, trendingRank: r.trendingRank }) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ---------------------------------------------------------------- breadth

export interface Breadth { asOf: string; stocks: number; advancing: number; declining: number; highs: number; lows: number; mood: number; moodLabel: string; parts: string }

/** Pure: breadth over a set of daily bars (oldest first per symbol), plus a 0-100 mood from four parts. */
export function breadth(bySymbol: Map<string, DailyBar[]>, spy: DailyBar[], vixNow: number | null, vixAvg: number | null): Breadth | null {
  let adv = 0, dec = 0, highs = 0, lows = 0, n = 0, asOf = "";
  for (const bars of bySymbol.values()) {
    if (bars.length < 2) continue;
    const last = bars[bars.length - 1], prev = bars[bars.length - 2];
    if (last.date > asOf) asOf = last.date;
    n++;
    if (last.c > prev.c) adv++;
    else if (last.c < prev.c) dec++;
    const year = bars.slice(-253, -1);
    if (year.length >= 120) {
      if (last.c >= Math.max(...year.map((b) => b.h))) highs++;
      if (last.c <= Math.min(...year.map((b) => b.l))) lows++;
    }
  }
  if (!n) return null;
  const parts: Array<[string, number]> = [["advancing", (adv / Math.max(adv + dec, 1)) * 100], ["highs vs lows", highs + lows ? (highs / (highs + lows)) * 100 : 50]];
  const s = spy.slice(-126);
  if (s.length >= 100) {
    const avg = s.reduce((a, b) => a + b.c, 0) / s.length;
    parts.push(["S&P vs 125-day average", Math.max(0, Math.min(100, 50 + (s[s.length - 1].c / avg - 1) * 100 * 5))]);
  }
  if (vixNow && vixAvg) parts.push(["VIX vs its 1-year average", Math.max(0, Math.min(100, 50 - (vixNow / vixAvg - 1) * 100))]);
  const mood = Math.round(parts.reduce((a, p) => a + p[1], 0) / parts.length);
  const moodLabel = mood < 25 ? "Extreme fear" : mood < 45 ? "Fear" : mood <= 55 ? "Neutral" : mood <= 75 ? "Greed" : "Extreme greed";
  return { asOf, stocks: n, advancing: adv, declining: dec, highs, lows, mood, moodLabel, parts: parts.map(([k, v]) => `${k} ${Math.round(v)}`).join(" · ") };
}

export const BREADTH_SYMBOLS = [...new Set(Object.values(UNIVERSE).flat())];

export async function breadthPanel(now: Date): Promise<Breadth> {
  const today = toEt(now).date;
  const rows = await store.loadBars([...BREADTH_SYMBOLS, "SPY"], addDays(today, -380), today);
  const by = new Map<string, DailyBar[]>();
  for (const r of rows) by.set(r.symbol, [...(by.get(r.symbol) ?? []), r]);
  const spy = by.get("SPY") ?? [];
  by.delete("SPY");
  const v = await vix().catch(() => null);
  const b = breadth(by, spy, v?.last ?? null, v?.avg1y ?? null);
  if (!b) throw new Error("no bars for the 390-stock universe yet (they load with the after-close job)");
  return b;
}

/** After the close (housekeeping): a year of daily bars for the breadth universe and SPY, incremental. */
export async function ensureBreadthBars(data: MarketData, now: Date): Promise<number> {
  const today = toEt(now).date;
  const from = addDays(today, -380);
  const have = await store.loadBars([BREADTH_SYMBOLS[0]], from, today);
  const start = have.length && have[0].date <= addDays(from, 10) ? addDays(have[have.length - 1].date, -4) : from;
  if (start > today) return 0;
  const bars = await data.getDailyBars([...BREADTH_SYMBOLS, "SPY"], start, today);
  return store.upsertBars(bars.filter((b) => b.date < today || toEt(now).minutes >= 16 * 60 + 15));
}
