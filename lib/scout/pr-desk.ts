/**
 * Press-release desk: a forward test of the "hot press release" day-trading method (Sean Dekmar's video). Watch the
 * press-release waves (7:00-9:30 AM ET, heaviest at 8:00 and 8:30, and after the 4 PM close), read only the headline
 * for hot keywords, prefer small floats, never touch an offering, and get in before the crowd.
 *
 * Every minute in those windows the scout logs each new single-company headline with his keyword score, the price
 * when it was published (from 1-minute bars, filled in later) and when the scout first saw it, the delay between
 * the two, and later the move 15 and 60 minutes after it was seen, that session's close and the next close. Shares
 * outstanding (Finnhub) stand in for the float, which no free source gives. Nothing is traded; no AI.
 */
import type { DailyBar, MarketData, MinuteBar, NewsItem } from "../alpaca";
import { query as q } from "../db";
import { addDays, toEt } from "../time";
import * as store from "./store";

/** His keyword list: three-star words, two-star words, and the words that sink a stock. */
export const HOT3 = ["positive", "significant", "statistically significant", "primary endpoint", "endpoints", "topline", "top-line", "demonstrates", "demonstrated", "treatment", "cancer", "agreement", "partnership", "collaboration", "successful", "awarded", "phase 3", "breakthrough", "cure", "met"];
export const HOT2 = ["approval", "approves", "approved", "fast track", "orphan drug", "clearance", "acquires", "acquisition", "merger", "contract", "completes", "promising", "achieves", "record revenue", "launches", "patent", "strategic", "order", "selected"];
export const SINKERS = ["offering", "priced", "pricing of", "registered direct", "at-the-market", "warrants", "reverse stock split", "reverse split", "delisting", "deficiency", "going concern", "bankruptcy", "chapter 11", "discontinue", "fails to", "failed to", "terminates", "resigns"];

export const PR = { maxPerRun: 120, sharesPerRun: 15, fillPerRun: 4, smallSharesM: 20 };

export interface Scored { stars: number; hot: string[]; sinkers: string[]; earnings: boolean }

const has = (h: string, w: string) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(h);

/** Pure: his score for a headline: 3 points per three-star word, 2 per two-star word; offerings and the like flagged. */
export function scoreHeadline(h: string): Scored {
  const hot3 = HOT3.filter((w) => has(h, w)), hot2 = HOT2.filter((w) => has(h, w));
  return { stars: hot3.length * 3 + hot2.length * 2, hot: [...hot3, ...hot2], sinkers: SINKERS.filter((w) => has(h, w)), earnings: /financial results|quarter(ly)? results|reports? (q[1-4]|first|second|third|fourth|fiscal)/i.test(h) };
}

/** Pure: is this ET moment in a press-release window (weekdays 6:55-9:40 AM and 3:55-6:30 PM)? */
export function inWindow(date: string, minutes: number): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return (minutes >= 6 * 60 + 55 && minutes <= 9 * 60 + 40) || (minutes >= 15 * 60 + 55 && minutes <= 18 * 60 + 30);
}

/** Pure: a company press release-like item: one or two tickers, not a re-post. */
export const isCompanyItem = (n: NewsItem) => n.symbols.length >= 1 && n.symbols.length <= 2 && !n.repostedAt && /^[A-Z]{1,5}$/.test(n.symbols[0]);

/** Pure: the close of the last 1-minute bar at or before a moment (the first one after, if none before). */
export function priceAt(bars: MinuteBar[], at: number): number | null {
  let p: number | null = null;
  for (const b of bars) { if (Date.parse(b.t) <= at) p = b.c; else { if (p === null) p = b.c; break; } }
  return p;
}

/** Pure: the session a moment belongs to for "that day's close": the same weekday before 4 PM ET, else the next. */
export function sessionDay(seenIso: string, bars: DailyBar[]): { day: DailyBar | null; next: DailyBar | null } {
  const et = toEt(new Date(seenIso));
  const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  const i = s.findIndex((b) => b.date > et.date || (b.date === et.date && et.minutes < 16 * 60));
  return i < 0 ? { day: null, next: null } : { day: s[i], next: s[i + 1] ?? null };
}

async function sharesOut(symbol: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  const key = env.FINNHUB_API_KEY?.trim();
  if (!key) return null;
  const hit = await store.cacheGet<number | null>(`shares:${symbol}`).catch(() => null);
  if (hit && Date.now() - Date.parse(hit.updatedAt) < 30 * 86400_000) return hit.data;
  const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}`, { headers: { "X-Finnhub-Token": key, accept: "application/json" } }).catch(() => null);
  const j = res?.ok ? ((await res.json().catch(() => null)) as { shareOutstanding?: number } | null) : null;
  const v = typeof j?.shareOutstanding === "number" && j.shareOutstanding > 0 ? Math.round(j.shareOutstanding * 10) / 10 : null;
  await store.cachePut(`shares:${symbol}`, v).catch(() => undefined);
  return v;
}

/** One pass (every minute): log new headlines in the windows, then fill in a few outcomes. */
export async function runPrDesk(deps: { data: MarketData | null; now: Date; env?: NodeJS.ProcessEnv }): Promise<string> {
  const { data, now } = deps;
  if (!data) return "pr desk: no market data";
  const env = deps.env ?? process.env;
  const et = toEt(now);
  let logged = 0;
  if (inWindow(et.date, et.minutes)) {
    const cursor = (await store.cacheGet<string>("prdesk:cursor").catch(() => null))?.data;
    const from = new Date(Math.max(cursor ? Date.parse(cursor) : 0, now.getTime() - 20 * 60_000));
    const news = (await data.getNews([], from, now, 200).catch(() => [] as NewsItem[])).filter(isCompanyItem).slice(0, PR.maxPerRun);
    await store.cachePut("prdesk:cursor", now.toISOString()).catch(() => undefined);
    if (news.length) {
      const syms = [...new Set(news.map((n) => n.symbols[0]))];
      const snaps = (data.getSnapshots ? await data.getSnapshots(syms).catch(() => ({})) : {}) as Record<string, { price: number; prevClose: number | null; volume?: number | null }>;
      let shareCalls = 0;
      for (const n of news) {
        const s = n.symbols[0], sc = scoreHeadline(n.headline), snap = snaps[s];
        const shares = sc.stars >= 3 && shareCalls++ < PR.sharesPerRun ? await sharesOut(s, env) : null;
        const r = await q(
          `INSERT INTO pr_watch (news_id, symbol, published_at, seen_at, headline, url, source, stars, hot, sinkers, earnings, shares_out_m, prev_close, price_seen, vol_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (news_id) DO NOTHING RETURNING id`,
          [n.id, s, n.ts, now.toISOString(), n.headline.slice(0, 400), n.url, n.source, sc.stars, sc.hot, sc.sinkers, sc.earnings, shares, snap?.prevClose ?? null, snap?.price ?? null, snap?.volume ?? null],
        );
        if (r.length) logged++;
      }
    }
  }
  // Outcomes: minute prices once an hour has passed, closes once the sessions are done (a few rows a minute).
  let filled = 0;
  if (data.getMinuteBars) {
    const due = await q(`SELECT id, symbol, published_at, seen_at FROM pr_watch WHERE p60 IS NULL AND seen_at < now() - interval '65 minutes' AND seen_at > now() - interval '5 days' ORDER BY seen_at LIMIT $1`, [PR.fillPerRun]);
    for (const r of due) {
      const pub = Date.parse(r.published_at as string), seen = Date.parse(r.seen_at as string);
      const bars = await data.getMinuteBars(String(r.symbol), new Date(Math.min(pub, seen) - 5 * 60_000), new Date(seen + 66 * 60_000)).catch(() => [] as MinuteBar[]);
      const after = bars.filter((b) => Date.parse(b.t) >= seen);
      await q(`UPDATE pr_watch SET price_pub = $2, p15 = $3, p60 = $4, high60 = $5, vol60 = $6 WHERE id = $1`, [r.id, priceAt(bars, pub), priceAt(bars, seen + 15 * 60_000), priceAt(bars, seen + 60 * 60_000) ?? -1, after.length ? Math.max(...after.map((b) => b.h)) : null, after.reduce((x, b) => x + b.v, 0)]);
      filled++;
    }
  }
  const closes = await q(`SELECT id, symbol, seen_at FROM pr_watch WHERE next_close IS NULL AND seen_at < now() - interval '30 hours' AND seen_at > now() - interval '10 days' ORDER BY seen_at LIMIT $1`, [PR.fillPerRun]);
  for (const r of closes) {
    const d = toEt(new Date(r.seen_at as string)).date;
    const bars = await data.getDailyBars([String(r.symbol)], d, addDays(d, 8)).catch(() => [] as DailyBar[]);
    const { day, next } = sessionDay(new Date(r.seen_at as string).toISOString(), bars);
    if (!next) continue;
    await q(`UPDATE pr_watch SET day_open = $2, day_close = $3, next_close = $4 WHERE id = $1`, [r.id, day?.o ?? null, day?.c ?? null, next.c]);
    filled++;
  }
  return `pr desk: ${logged} logged, ${filled} outcomes filled`;
}

export interface PrRow {
  id: number; symbol: string; publishedAt: string; seenAt: string; headline: string; url: string | null; source: string; stars: number; hot: string[]; sinkers: string[]; earnings: boolean;
  sharesOutM: number | null; prevClose: number | null; priceSeen: number | null; volSeen: number | null; pricePub: number | null; p15: number | null; p60: number | null; high60: number | null; vol60: number | null;
  dayOpen: number | null; dayClose: number | null; nextClose: number | null;
}

const n = (v: unknown) => (v === null || v === undefined || Number(v) < 0 ? null : Number(v));
export async function prRows(days = 30, limit = 1500): Promise<PrRow[]> {
  return (await q(`SELECT * FROM pr_watch WHERE seen_at > now() - ($1::int * interval '1 day') ORDER BY seen_at DESC LIMIT $2`, [days, limit])).map((r) => ({
    id: Number(r.id), symbol: String(r.symbol), publishedAt: new Date(r.published_at as string).toISOString(), seenAt: new Date(r.seen_at as string).toISOString(), headline: String(r.headline), url: (r.url as string) || null, source: String(r.source ?? ""),
    stars: Number(r.stars), hot: (r.hot as string[]) ?? [], sinkers: (r.sinkers as string[]) ?? [], earnings: !!r.earnings, sharesOutM: n(r.shares_out_m), prevClose: n(r.prev_close), priceSeen: n(r.price_seen), volSeen: n(r.vol_seen),
    pricePub: n(r.price_pub), p15: n(r.p15), p60: n(r.p60), high60: n(r.high60), vol60: n(r.vol60), dayOpen: n(r.day_open), dayClose: n(r.day_close), nextClose: n(r.next_close),
  }));
}

/** Pure: the groups the method predicts should differ, with mean moves from the moment the scout saw the headline. */
export type PrGroup = "hot_small" | "hot" | "plain" | "sinker" | "earnings";
export function prGroup(r: Pick<PrRow, "stars" | "sinkers" | "earnings" | "sharesOutM">): PrGroup {
  if (r.sinkers.length) return "sinker";
  if (r.earnings) return "earnings";
  if (r.stars >= 3) return r.sharesOutM !== null && r.sharesOutM <= PR.smallSharesM ? "hot_small" : "hot";
  return "plain";
}

export function groupStats(rows: PrRow[]): Array<{ group: PrGroup; n: number; m15: number | null; m60: number | null; mClose: number | null; mNext: number | null; upClose: number | null }> {
  const move = (a: number | null, b: number | null) => (a && b ? (b / a - 1) * 100 : null);
  const avg = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  return (["hot_small", "hot", "plain", "earnings", "sinker"] as PrGroup[]).map((g) => {
    const xs = rows.filter((r) => prGroup(r) === g && r.priceSeen);
    const closes = xs.map((r) => move(r.priceSeen, r.dayClose)).filter((x): x is number => x !== null);
    return { group: g, n: xs.length, m15: avg(xs.map((r) => move(r.priceSeen, r.p15))), m60: avg(xs.map((r) => move(r.priceSeen, r.p60))), mClose: avg(closes), mNext: avg(xs.map((r) => move(r.priceSeen, r.nextClose))), upClose: closes.length ? Math.round((closes.filter((x) => x > 0).length / closes.length) * 100) : null };
  });
}
