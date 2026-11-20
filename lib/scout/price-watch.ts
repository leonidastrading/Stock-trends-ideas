/**
 * Price watch: a big company moving 5% or more on the day is breaking news whatever the source. Stories that break on
 * X, in a short-seller report or a niche outlet (AMD, Nov 19 2026: a Hunterbrook investigation posted on X at 10:32 AM,
 * the stock down 8% minutes later) reach none of the scout's feeds, but the move itself shows up in prices.
 *
 * One snapshot request per 100 of the scout's ~400 large and mid caps, at most once a minute (shared by the News tab,
 * the breaking strip and the phone alerts). A move counts once per stock, day, session part and level (5%, then 10%),
 * and keeps the time it was first seen.
 *
 * Pre-market and after-hours trading is thin on IEX, so (ROST, Nov 19 2026: "down 12.2% today" was an after-hours
 * drop on earnings, measured from the day before's close): a move is labelled by session part (pre-market, today,
 * after hours), after hours is measured from today's close, a move the quote midpoint does not back is ignored, and a
 * phone alert waits until the move has held for two checks.
 */
import type { MarketData, NewsItem } from "../alpaca";
import { addDays, toEt } from "../time";
import { UNIVERSE } from "@/config/universe";
import * as store from "./store";

/** The scout's large and mid caps: big enough that their news, and their moves, are market news even without a card. */
export const BIG_NAMES = new Set(Object.values(UNIVERSE).flat());

/**
 * specificGap: a move counts as the stock's own news only when it beats the typical move in its sector (the median
 * of the scout's names in that sector today) by this many points; a stock falling with its whole sector is not news
 * (Nov 20 2026: GLW, VRT, LRCX, STX and ANET all down 5-7% in a chip and AI sell-off at the open).
 */
export const PRICE_WATCH = { levels: [5, 10], refreshMs: 60_000, minPrice: 5, specificGap: 4 };

/** Each big name's sector. */
const SECTOR_OF: Map<string, string> = new Map(Object.entries(UNIVERSE).flatMap(([sector, syms]) => syms.map((s) => [s, sector] as [string, string])));

/** When the price is from: before the open, the regular session, or after the close (US Eastern). */
export type Phase = "pre" | "regular" | "post";
export interface BigMove { symbol: string; pct: number; price: number; prevClose: number; date: string; level: number; key: string; firstSeen: string; phase: Phase; vs: string; sector?: string | null; sectorPct?: number | null; specific?: boolean }
interface Snap { price: number; prevClose: number | null; sessionDate?: string | null; at?: string | null; dailyClose?: number | null; mid?: number | null }

export const phaseOf = (at: Date): Phase => { const m = toEt(at).minutes; return m < 9 * 60 + 30 ? "pre" : m >= 16 * 60 ? "post" : "regular"; };
export const PHASE_LABEL: Record<Phase, string> = { pre: "pre-market", regular: "today", post: "after hours" };

/**
 * Pure: the big names that have moved past a level today (the highest level each has reached), by session part:
 * pre-market and the regular session against the last close, after hours against today's close.
 */
export function bigMoves(snaps: Record<string, Snap>, today: string, levels = PRICE_WATCH.levels, now = new Date()): Array<Omit<BigMove, "firstSeen">> {
  const out: Array<Omit<BigMove, "firstSeen">> = [];
  const moved: Array<{ symbol: string; pct: number }> = [];
  for (const [symbol, s] of Object.entries(snaps)) {
    if (!s.price) continue;
    const at = s.at ? new Date(s.at) : now;
    if (toEt(at).date !== today) continue; // no trade today yet: yesterday's move is not news
    const phase = phaseOf(at);
    const barToday = s.sessionDate === today;
    let base: number | null | undefined, vs: string;
    if (phase === "post" && barToday && s.dailyClose && Math.abs(s.price / s.dailyClose - 1) > 0.0005) { base = s.dailyClose; vs = "today's close"; }
    else if (barToday || !s.sessionDate) { base = s.prevClose; vs = phase === "post" ? "yesterday's close" : "the last close"; }
    else { base = s.dailyClose ?? s.prevClose; vs = "the last close"; } // before today's first trade in the bar: the bar is the last session
    if (!base || base < PRICE_WATCH.minPrice || s.price < PRICE_WATCH.minPrice) continue; // under $5: not market news
    const pct = Math.round((s.price / base - 1) * 1000) / 10;
    moved.push({ symbol, pct });
    const level = [...levels].reverse().find((l) => Math.abs(pct) >= l);
    if (!level) continue;
    // One odd trade is not a move: the quote midpoint must agree, when there is a sane quote.
    if (s.mid && !(Math.abs(s.mid / base - 1) * 100 >= level * 0.8 && Math.sign(s.mid - base) === Math.sign(pct))) continue;
    out.push({ symbol, pct, price: s.price, prevClose: base, date: today, level, phase, vs, key: `move:${symbol}:${today}:${phase}:${level}` });
  }
  // The typical move in each sector today (the median of its names, when at least 5 have a price).
  const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const bySector = new Map<string, number[]>();
  for (const m of moved) { const sec = SECTOR_OF.get(m.symbol); if (sec) bySector.set(sec, [...(bySector.get(sec) ?? []), m.pct]); }
  const sectorPct = new Map([...bySector].filter(([, xs]) => xs.length >= 5).map(([sec, xs]) => [sec, Math.round(median(xs) * 10) / 10] as const));
  return out.map((m) => {
    const sector = SECTOR_OF.get(m.symbol) ?? null;
    const sp = sector ? sectorPct.get(sector) ?? null : null;
    return { ...m, sector, sectorPct: sp, specific: sp === null || Math.abs(m.pct - sp) >= PRICE_WATCH.specificGap };
  }).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
}

/** Pure: a move that has held for two checks (seen at least 90 seconds ago and still there): ready for a phone alert. */
export const confirmed = (m: BigMove, now: Date) => now.getTime() - Date.parse(m.firstSeen) >= 90_000;

/** Law firms advertising for plaintiffs: they follow a drop, they do not explain it. */
export const LAW_FIRM_AD = /\b(law firms?|investigation on behalf of|on behalf of (?:investors|shareholders)|class action|lead plaintiff|shareholder alert|investor alert|securities litigation|investors? who (?:lost|purchased)|encourages? .{0,40}investors|reminds? .{0,40}(?:investors|shareholders)|contact the firm|recover(?:ing)? (?:their )?losses)\b/i;

/** Pure: the most recent headline on the stock in the last 3 hours (the likely reason), if any feed has one; law-firm ads are skipped. */
export function likelyReason(symbol: string, news: Array<Pick<NewsItem, "ts" | "headline" | "symbols" | "source" | "url">>, now: Date, windowMs = 3 * 3600_000): { headline: string; source: string; url: string } | null {
  const n = news.filter((x) => x.symbols.includes(symbol) && x.source !== "Nasdaq halts" && !LAW_FIRM_AD.test(x.headline) && now.getTime() - Date.parse(x.ts) <= windowMs).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  return n ? { headline: n.headline, source: n.source, url: n.url } : null;
}

export interface LiveBreadth { advancing: number; declining: number; unchanged: number; at: string; date: string }
const memo = { at: 0, moves: [] as BigMove[], penny: new Set<string>(), breadth: null as LiveBreadth | null };

/** Pure: how many of the big names are up and down today against the last close (only names that traded today). */
export function breadthNow(snaps: Record<string, Snap>, today: string, now: Date): LiveBreadth | null {
  let advancing = 0, declining = 0, unchanged = 0;
  for (const s of Object.values(snaps)) {
    if (!s.price || !s.at || toEt(new Date(s.at)).date !== today) continue;
    const base = s.sessionDate === today ? s.prevClose : s.dailyClose ?? s.prevClose;
    if (!base) continue;
    const ch = s.price / base - 1;
    if (ch > 0.0005) advancing++; else if (ch < -0.0005) declining++; else unchanged++;
  }
  return advancing + declining + unchanged >= 20 ? { advancing, declining, unchanged, at: now.toISOString(), date: today } : null;
}

/** Today's advancers and decliners among the big names, from the latest price check (null before today's first trades). */
export async function liveBreadth(data: MarketData | null, now = new Date()): Promise<LiveBreadth | null> {
  await priceWatch(data, now).catch(() => []);
  return memo.breadth && memo.breadth.date === toEt(now).date ? memo.breadth : null;
}

/** The scout's big names last seen under $5 (from the latest price check). */
export const pennySymbols = (): Set<string> => memo.penny;

/** Today's big moves (cached a minute), with the time each was first seen. */
export async function priceWatch(data: MarketData | null, now = new Date()): Promise<BigMove[]> {
  if (!data?.getSnapshots) return [];
  if (Date.now() - memo.at < PRICE_WATCH.refreshMs) return memo.moves;
  const today = toEt(now).date;
  const snaps = await data.getSnapshots([...BIG_NAMES]).catch(() => null);
  if (!snaps) return memo.moves;
  const moves = bigMoves(snaps as Record<string, Snap>, today, PRICE_WATCH.levels, now);
  memo.penny = new Set(Object.entries(snaps as Record<string, Snap>).filter(([, s]) => s.price > 0 && s.price < PRICE_WATCH.minPrice).map(([sym]) => sym));
  memo.breadth = breadthNow(snaps as Record<string, Snap>, today, now);
  const seen = (await store.cacheGet<Record<string, string>>("price-watch:first").catch(() => null))?.data ?? {};
  let changed = false;
  for (const m of moves) if (!seen[m.key]) { seen[m.key] = now.toISOString(); changed = true; }
  if (changed) {
    // Keep two days of keys.
    const keep = Object.fromEntries(Object.entries(seen).filter(([, at]) => now.getTime() - Date.parse(at) < 2 * 86400_000));
    await store.cachePut("price-watch:first", keep).catch(() => undefined);
  }
  memo.moves = moves.map((m) => ({ ...m, firstSeen: seen[m.key] ?? now.toISOString() }));
  memo.at = Date.now();
  return memo.moves;
}

/** Pure: "ROST down 10.4% after hours". */
export const moveTitle = (m: Pick<BigMove, "symbol" | "pct" | "phase">) => `${m.symbol} ${m.pct >= 0 ? "up" : "down"} ${Math.abs(m.pct).toFixed(1)}% ${PHASE_LABEL[m.phase ?? "regular"]}`;

/** Pure: a move as a news item for the News tab and the breaking strip. */
export function moveItem(m: BigMove, reason: { headline: string; source: string; url: string } | null): NewsItem {
  const thin = m.phase !== "regular" ? " Pre-market and after-hours trading is thin: the price can swing more than it will at the open." : "";
  return {
    id: Math.abs([...m.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)),
    ts: m.firstSeen,
    headline: `${moveTitle(m)}${reason ? `: ${reason.headline}` : ", no headline in the scout's feeds yet"}`,
    summary: `${m.symbol} at $${m.price.toFixed(2)} against $${m.prevClose.toFixed(2)} at ${m.vs ?? "the last close"} (past ${m.level}%).${reason ? ` Likely reason (${reason.source}): ${reason.headline}` : " The news may be on X, in a short report or a niche outlet: check the stock's own news."}${thin}`,
    symbols: [m.symbol], source: "Scout price watch", url: reason?.url || `/chart?symbol=${m.symbol}`,
  };
}

/** Pure: an earnings release as the reason for a move (reported today, or yesterday after the close for a pre-market move). */
export function earningsReason(symbol: string, rows: Array<{ symbol: string; date: string; time?: string | null }>, today: string, phase: Phase): { headline: string; source: string; url: string } | null {
  const r = rows.find((x) => x.symbol === symbol && (x.date === today || (phase === "pre" && x.date < today && /after|amc|post/i.test(x.time ?? ""))));
  if (!r) return null;
  const when = /after|amc|post/i.test(r.time ?? "") ? "after the close" : /pre|bmo|before/i.test(r.time ?? "") ? "before the open" : "";
  return { headline: `${symbol} reported earnings ${r.date === today ? "today" : "yesterday"}${when ? ` ${when}` : ""}`, source: "earnings calendar", url: `/chart?symbol=${symbol}` };
}

/** The likely reason for a move: the newest headline on the stock, else an earnings release today. */
export async function reasonFor(m: Pick<BigMove, "symbol" | "phase">, news: Array<Pick<NewsItem, "ts" | "headline" | "symbols" | "source" | "url">>, now: Date, windowMs?: number): Promise<{ headline: string; source: string; url: string } | null> {
  const hit = likelyReason(m.symbol, news, now, windowMs);
  if (hit) return hit;
  const { earningsOn } = await import("../market/sources");
  const today = toEt(now).date;
  const days = m.phase === "pre" ? [today, addDays(today, -1), addDays(today, -3)] : [today];
  const rows = (await Promise.all(days.map((d) => earningsOn(d).catch(() => [])))).flat();
  return earningsReason(m.symbol, rows, today, m.phase);
}
