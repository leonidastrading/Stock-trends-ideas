/**
 * How expensive are the options? A read for the card's "how to trade it" note,
 * after the NVDA lesson: once a story is everywhere, put prices jump and the
 * cheap entry is gone. Market data only (Alpaca's option snapshots; the free
 * feed is indicative and 15 minutes delayed). Nothing here is a recommendation
 * and nothing is tracked in options.
 *
 * The read: median implied volatility of near-the-money calls 20-60 days out,
 * against the stock's own 20-day realized volatility from daily closes.
 */
import type { DailyBar, MarketData } from "../alpaca";
import { addDays, daysBetween, toEt } from "../time";

export const OPTIONS = { minDays: 20, maxDays: 60, moneyness: 0.05, rvDays: 20, cheapBelow: 1.1, expensiveFrom: 1.5 };

/** OCC symbol, e.g. NVDA261218C00150000 → expiry 2026-12-18, call, strike 150. */
export function parseOcc(symbol: string): { root: string; expiry: string; type: "call" | "put"; strike: number } | null {
  const m = /^([A-Z][A-Z.]{0,9}?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol);
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000 };
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure: annualized volatility of daily log returns over the last `n` closes. */
export function realizedVol(bars: DailyBar[], n = OPTIONS.rvDays): number | null {
  const c = bars.slice().sort((a, b) => a.date.localeCompare(b.date)).map((b) => b.c).slice(-(n + 1));
  if (c.length < Math.min(n + 1, 11)) return null;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}

/** Pure: median implied volatility of near-the-money contracts 20-60 days out. */
export function atmIv(snapshots: Record<string, { impliedVolatility?: number | null }>, spot: number, today: string): { iv: number; contracts: number } | null {
  const ivs: number[] = [];
  for (const [sym, s] of Object.entries(snapshots)) {
    const o = parseOcc(sym);
    const iv = s?.impliedVolatility;
    if (!o || typeof iv !== "number" || !(iv > 0) || iv > 5) continue;
    const days = daysBetween(today, o.expiry);
    if (days < OPTIONS.minDays || days > OPTIONS.maxDays) continue;
    if (Math.abs(o.strike / spot - 1) > OPTIONS.moneyness) continue;
    ivs.push(iv);
  }
  return ivs.length ? { iv: median(ivs), contracts: ivs.length } : null;
}

export interface OptionsRead { ticker: string; iv: number; rv: number | null; ratio: number | null; label: "cheap" | "normal" | "expensive" | "unknown"; contracts: number; line: string }

export function describe(ticker: string, iv: number, rv: number | null, contracts: number): OptionsRead {
  const ratio = rv ? iv / rv : null;
  const label = ratio === null ? "unknown" : ratio < OPTIONS.cheapBelow ? "cheap" : ratio >= OPTIONS.expensiveFrom ? "expensive" : "normal";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const line = `Options on ${ticker} (indicative, 15-min delayed): ${OPTIONS.minDays}-${OPTIONS.maxDays} day at-the-money implied volatility ${pct(iv)}${rv ? ` vs ${OPTIONS.rvDays}-day realized ${pct(rv)} (${ratio!.toFixed(1)}x: options look ${label} against the stock's own recent moves)` : " (no realized volatility to compare)"}; median of ${contracts} contracts.`;
  return { ticker, iv: Math.round(iv * 1000) / 1000, rv: rv === null ? null : Math.round(rv * 1000) / 1000, ratio: ratio === null ? null : Math.round(ratio * 100) / 100, label, contracts, line };
}

/** Fetch and describe; null when the data is not available (no options, no access). Throws only on transport errors. */
export async function optionsRead(data: MarketData, ticker: string, now: Date): Promise<OptionsRead | null> {
  if (!data.getOptionSnapshots) return null;
  const today = toEt(now).date;
  const bars = (await data.getDailyBars([ticker], addDays(today, -45), today)).filter((b) => b.symbol === ticker);
  const spot = bars.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.c;
  if (!spot) return null;
  const snaps = await data.getOptionSnapshots(ticker, { type: "call", strikeGte: Math.floor(spot * (1 - OPTIONS.moneyness)), strikeLte: Math.ceil(spot * (1 + OPTIONS.moneyness)), expiryGte: addDays(today, OPTIONS.minDays), expiryLte: addDays(today, OPTIONS.maxDays) });
  const a = atmIv(snaps, spot, today);
  return a ? describe(ticker, a.iv, realizedVol(bars), a.contracts) : null;
}
