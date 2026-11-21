/**
 * The bigger picture for every card: what the AI trade as a whole is doing. Single-stock theses on AI-linked names
 * (optics, chips, power, servers, neoclouds) move with the theme: when the AI trade unwinds, a good stock-specific
 * story can still lose, and a short on a stretched name has the tide with it. Measured, not guessed:
 * - a basket of AI leaders and picks-and-shovels: how many are below their 50-day average, the median drop from the
 *   3-month high, the basket's 5- and 20-day return against SPY, names more than 20% off their highs;
 * - "AI bubble" / AI sell-off headlines this week against the week before.
 * The regime label is a rule of thumb; research is told to weigh it in the risks, never to treat it as news.
 */
import type { DailyBar, MarketData } from "../alpaca";
import { addDays, toEt } from "../time";
import * as store from "./store";

export const AI_BASKET = ["NVDA", "AVGO", "AMD", "MU", "TSM", "ARM", "MRVL", "ANET", "VRT", "COHR", "LITE", "AAOI", "CLS", "SMCI", "DELL", "ORCL", "PLTR", "CRWV", "VST", "CEG"] as const;
export const AI_LINKED = new Set<string>([...AI_BASKET, "INTC", "QCOM", "AMAT", "LRCX", "KLAC", "ASML", "MSFT", "META", "GOOGL", "GOOG", "AMZN", "NBIS", "IREN", "CIFR", "WULF", "APLD", "FN", "CIEN", "GLW", "ALAB", "CRDO", "SNOW", "MDB", "NOW", "TLN", "OKLO", "SMR", "ETN", "GEV", "PWR", "STX", "WDC", "SNDK", "HPE"]);
export const BUBBLE_NEWS = /\bAI bubble\b|\bAI[- ](sell-?off|rout|unwind|wreck|reckoning)\b|\bAI (trade|stocks?|names|chip stocks?|rally)\b.{0,40}\b(sell-?off|rout|unwind|slump|plunge|tumble|crash|wobble|correction|pops?)\b|\b(sell-?off|rout|unwind|slump|crash)\b.{0,30}\bAI (stocks?|trade|names)\b|\bcapex (cuts?|pullback|fatigue|digestion)\b|\bAI (spending|capex) (doubts?|fears?|concerns?)\b/i;

export interface Backdrop {
  asOf: string; names: number; below50: number; medianOffHigh: number | null; over20Off: string[];
  basket5: number | null; basket20: number | null; spy5: number | null; spy20: number | null;
  bubbleNews: number | null; bubbleNewsBefore: number | null;
  regime: "unwinding" | "under pressure" | "intact" | "unknown";
}

const ret = (b: DailyBar[], n: number) => (b.length > n && b[b.length - 1 - n].c > 0 ? (b[b.length - 1].c / b[b.length - 1 - n].c - 1) * 100 : null);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: the AI basket's state from daily bars (any order; SPY included). */
export function measureBackdrop(bars: DailyBar[], asOf: string, news?: { now: number; before: number }): Backdrop {
  const by = new Map<string, DailyBar[]>();
  for (const b of bars) by.set(b.symbol, [...(by.get(b.symbol) ?? []), b]);
  for (const v of by.values()) v.sort((a, b) => a.date.localeCompare(b.date));
  const offs: number[] = [], r5: number[] = [], r20: number[] = [], over20: string[] = [];
  let below50 = 0, names = 0;
  for (const s of AI_BASKET) {
    const b = by.get(s);
    if (!b || b.length < 60) continue;
    names++;
    const last = b[b.length - 1].c;
    const sma50 = b.slice(-50).reduce((a, x) => a + x.c, 0) / 50;
    if (last < sma50) below50++;
    const high = Math.max(...b.slice(-63).map((x) => x.c));
    const off = (last / high - 1) * 100;
    offs.push(off);
    if (off <= -20) over20.push(`${s} ${Math.round(off)}%`);
    const a = ret(b, 5), c = ret(b, 20);
    if (a !== null) r5.push(a);
    if (c !== null) r20.push(c);
  }
  const med = (xs: number[]) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return r1(s[Math.floor(s.length / 2)]); };
  const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const spy = by.get("SPY") ?? [];
  const out: Backdrop = {
    asOf, names, below50, medianOffHigh: med(offs), over20Off: over20, basket5: avg(r5), basket20: avg(r20), spy5: spy.length ? (ret(spy, 5) === null ? null : r1(ret(spy, 5)!)) : null, spy20: spy.length ? (ret(spy, 20) === null ? null : r1(ret(spy, 20)!)) : null,
    bubbleNews: news?.now ?? null, bubbleNewsBefore: news?.before ?? null, regime: "unknown",
  };
  if (names < 8 || out.medianOffHigh === null) return out;
  const share = below50 / names;
  const lag20 = out.basket20 !== null && out.spy20 !== null ? out.basket20 - out.spy20 : 0;
  out.regime = out.medianOffHigh <= -20 || (share >= 0.7 && lag20 <= -8) ? "unwinding" : out.medianOffHigh <= -12 || share >= 0.5 || lag20 <= -5 ? "under pressure" : "intact";
  return out;
}

/** Pure: the backdrop as research reads it. */
export function backdropText(b: Backdrop): string | null {
  if (b.regime === "unknown") return null;
  const pp = (x: number | null) => (x === null ? "?" : `${x > 0 ? "+" : ""}${x}%`);
  return [
    `MARKET BACKDROP: THE AI TRADE (measured by the scout from prices on ${b.asOf}; context for the whole market, not evidence for this card):`,
    `- ${b.below50} of ${b.names} AI leaders and picks-and-shovels (chips, optics, networking, power, servers, neoclouds) are below their 50-day average; the median one is ${pp(b.medianOffHigh)} from its 3-month high${b.over20Off.length ? `; more than 20% off: ${b.over20Off.join(", ")}` : ""}.`,
    `- The basket did ${pp(b.basket5)} over 5 sessions and ${pp(b.basket20)} over 20, against SPY's ${pp(b.spy5)} and ${pp(b.spy20)}.`,
    b.bubbleNews !== null ? `- Headlines about an AI bubble, AI sell-offs or capex doubts: ${b.bubbleNews} in the last 7 days against ${b.bubbleNewsBefore} the week before.` : "",
    `- Regime: the AI trade is ${b.regime.toUpperCase()}.`,
    b.regime === "intact"
      ? "How to use it: AI-linked stocks still trade with a strong theme behind them; a long rides it, a short fights it. Say so in the risks when the call depends on it."
      : `How to use it: when the AI trade is ${b.regime}, AI-linked stocks tend to fall together whatever their own news, and the higher the beta and the further a name ran, the harder. A long on an AI-linked name needs a reason it would hold up if the theme keeps unwinding (and the time limit should allow for it); a short on a stretched AI name has the tide with it. A "beneficiary" of a policy or a customer's capex can still lose. State in the risks how the AI trade's direction affects this call; for names outside the theme, say whether it matters at all.`,
  ].filter(Boolean).join("\n");
}

/** The backdrop now (kept for an hour). Null when there are no prices. */
export async function aiBackdrop(data: MarketData | null, now: Date): Promise<Backdrop | null> {
  const cached = await store.cacheGet<Backdrop>("backdrop:ai").catch(() => null);
  if (cached && Date.now() - Date.parse(cached.updatedAt) < 3600_000) return cached.data;
  if (!data) return cached?.data ?? null;
  const today = toEt(now).date;
  try {
    const bars = await data.getDailyBars([...AI_BASKET, "SPY"], addDays(today, -130), today);
    const count = async (from: Date, to: Date) => (await data.getNews([], from, to, 1000)).filter((n) => BUBBLE_NEWS.test(`${n.headline} ${n.summary ?? ""}`)).length;
    const news = await Promise.all([count(new Date(now.getTime() - 7 * 86400_000), now), count(new Date(now.getTime() - 14 * 86400_000), new Date(now.getTime() - 7 * 86400_000))]).then(([a, b]) => ({ now: a, before: b })).catch(() => undefined);
    const b = measureBackdrop(bars, today, news);
    await store.cachePut("backdrop:ai", b).catch(() => undefined);
    return b;
  } catch {
    return cached?.data ?? null;
  }
}
