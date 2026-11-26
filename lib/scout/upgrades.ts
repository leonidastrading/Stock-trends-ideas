/**
 * Upgrades (up): broker upgrades to a buy rating, each a paper long from the moment it appears. No card, no AI.
 *
 * Why: the scout's own rating-change study (2019 to 2026, 1,124 upgrades on its large and mid caps) found that stocks
 * keep rising after an upgrade: about +0.4% against SPY in 5 trading days, +1% in 20 and +2.8% in 60 from the next
 * open, each unlikely to be chance, while downgrades showed no usable drift. Yet the scout only had a desk for
 * downgrades. What prompted it: Sanofi (SNY) rose about 5% on November 25, 2026, the day RBC upgraded it, a day
 * after jumping on its Insmed deal, and nothing in the scout looked at the long side.
 *
 * The rule: a headline in which a broker upgrades a stock to Buy, Outperform, Overweight or the like (not to Neutral,
 * and not a credit rating), on a stock at $5 or more that trades $5M or more a day. Entry at the price when it is
 * listed if the market is open, else the next open (an upgrade before the bell enters at that day's open). Held 60
 * trading days as in the study (84 calendar days), then closed; against SPY. It is a small average edge with wide
 * scatter: read the record, not single names.
 */
import type { DailyBar, MarketData, NewsItem } from "../alpaca";
import { query as q } from "../db";
import { addDays, etLabel, toEt } from "../time";
import { TOP_BROKERS } from "./drift";
import { inSession, openedBars, openEntry, timeExit } from "./drift-list";
import { paperResult, vsSpy } from "./paper-result";
import * as store from "./store";

export const UPGRADES = { holdDays: 84, minPrice: 5, minDollarVolume: 5e6, newsHours: 30, showDays: 12 };

export interface UpgradeInfo { broker: string | null; to: string; from: string | null; topBroker: boolean }

const BUY = "strong buy|buy|outperform|overweight|accumulate|positive|market outperform|sector outperform|add|top pick|conviction buy";
const NOT_STOCK = /\b(credit|debt|bonds?|notes|issuer|moody'?s|fitch|s&p global ratings|outlook|price target only|dividend)\b/i;

/**
 * Pure: what an upgrade headline says, or null when it is not a broker upgrading a stock to a buy rating.
 * "RBC Capital Markets Upgrades Sanofi to Outperform" -> RBC Capital Markets, to Outperform.
 */
export function upgradeInfo(h: string): UpgradeInfo | null {
  if (!/\bupgrades?\b|\braises? (?:rating )?(?:on .{1,40} )?to\b/i.test(h) || NOT_STOCK.test(h)) return null;
  const to = h.match(new RegExp(`\\bto\\s+(${BUY})\\b`, "i"))?.[1] ?? null;
  if (!to) return null;
  const broker = h.match(/^([A-Z][\w.&' -]{1,40}?)\s+(upgrades?|raises?|lifts?)\b/i)?.[1]?.trim() ?? null;
  const from = h.match(/\bfrom\s+(strong sell|sell|underperform|underweight|reduce|neutral|hold|market perform|sector perform|equal[- ]weight|in[- ]line|peer perform|mixed)\b/i)?.[1] ?? null;
  return { broker, to, from, topBroker: TOP_BROKERS.test(h) };
}

export interface Upgrade {
  symbol: string; day: string; brokers: string[]; to: string | null; from: string | null; topBroker: boolean; headline: string; url: string | null;
  newsAt: string; listedAt: string; prevClose: number | null;
  entryDate: string | null; entryPrice: number | null; spyEntry: number | null; basis: "listing" | "open";
  exitBy: string | null; exitDate: string | null; exitPrice: number | null; spyExit: number | null;
}

/** Pure: the upgrades in a batch of headlines, one per stock and day (several brokers on one stock the same day are one row). */
export function upgradesIn(news: Array<Pick<NewsItem, "ts" | "headline" | "symbols" | "url">>): Array<Pick<Upgrade, "symbol" | "day" | "brokers" | "to" | "from" | "topBroker" | "headline" | "url" | "newsAt">> {
  const by = new Map<string, ReturnType<typeof upgradesIn>[number]>();
  for (const n of [...news].sort((a, b) => a.ts.localeCompare(b.ts))) {
    // A headline tagged with several stocks is a round-up, not one broker on one stock.
    if (n.symbols.length !== 1 || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(n.symbols[0])) continue;
    const u = upgradeInfo(n.headline);
    if (!u) continue;
    const day = toEt(new Date(n.ts)).date, key = `${n.symbols[0]}|${day}`;
    const prev = by.get(key);
    if (prev) { if (u.broker && !prev.brokers.includes(u.broker)) prev.brokers.push(u.broker); prev.topBroker ||= u.topBroker; }
    else by.set(key, { symbol: n.symbols[0], day, brokers: u.broker ? [u.broker] : [], to: u.to, from: u.from, topBroker: u.topBroker, headline: n.headline, url: n.url || null, newsAt: n.ts });
  }
  return [...by.values()];
}

/** Pure: whether the stock is big and liquid enough (last close and the 20-day average dollar volume), and its last finished close. */
export function tradable(bars: Array<Pick<DailyBar, "date" | "c" | "v">>, day: string): { ok: boolean; prevClose: number | null } {
  const before = bars.filter((b) => b.date < day);
  const last = before.at(-1);
  const recent = before.slice(-20);
  const dollars = recent.length ? recent.reduce((a, b) => a + b.c * b.v, 0) / recent.length : 0;
  return { ok: !!last && last.c >= UPGRADES.minPrice && recent.length >= 10 && dollars >= UPGRADES.minDollarVolume, prevClose: last?.c ?? null };
}

/** Pure: the paper long's return and SPY's over the same span (null before it has entered). */
export function upgradeResult(u: Upgrade, priceNow: number | null, spyNow: number | null, now = new Date()) {
  const r = paperResult({ entryPrice: u.entryPrice, entryDate: u.entryDate, exitDate: u.exitDate, exitPrice: u.exitPrice, direction: "long", spyEntry: u.spyEntry, spyExit: u.spyExit }, priceNow, spyNow, now);
  return r ? { ...r, vsSpy: vsSpy("long", r) } : null;
}

const day = (v: unknown) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const toUpgrade = (r: Record<string, unknown>): Upgrade => ({
  symbol: String(r.symbol), day: day(r.day)!, brokers: (r.brokers as string[]) ?? [], to: (r.to_rating as string) ?? null, from: (r.from_rating as string) ?? null, topBroker: !!r.top_broker,
  headline: String(r.headline ?? ""), url: (r.url as string) ?? null, newsAt: new Date(r.news_at as string).toISOString(), listedAt: new Date(r.listed_at as string).toISOString(), prevClose: num(r.prev_close),
  entryDate: day(r.entry_date), entryPrice: num(r.entry_price), spyEntry: num(r.spy_entry), basis: r.basis as Upgrade["basis"],
  exitBy: day(r.exit_by), exitDate: day(r.exit_date), exitPrice: num(r.exit_price), spyExit: num(r.spy_exit),
});

/** Every upgrade on file, newest first. */
export async function upgradeBook(days = 400): Promise<Upgrade[]> {
  return (await q(`SELECT * FROM upgrade_list WHERE listed_at >= now() - ($1::int * interval '1 day') ORDER BY news_at DESC`, [days])).map(toUpgrade);
}

/** One pass: new upgrades from the news stream become paper longs; waiting entries and finished holds are settled. */
export async function runUpgrades(data: MarketData | null, now = new Date()): Promise<string> {
  if (!data) return "upgrades: waiting for market data (Alpaca keys)";
  const today = toEt(now).date;
  // The stream gives the newest headlines first, so a fixed count can stop hours short on a busy day (the first live
  // run reached only part of its 30 hours). Read everything since the last pass; the first pass reads the whole window.
  const last = (await store.cacheGet<{ at: string }>("upgrades:last").catch(() => null))?.data?.at ?? null;
  const since = new Date(Math.max(now.getTime() - UPGRADES.newsHours * 3600_000, last ? Date.parse(last) - 20 * 60000 : 0));
  const news = await data.getNews([], since, now, last ? 3000 : 6000);
  const found = upgradesIn(news);
  const have = found.length ? new Set((await q(`SELECT symbol, day FROM upgrade_list WHERE symbol = ANY($1)`, [found.map((u) => u.symbol)])).map((r) => `${r.symbol}|${day(r.day)}`)) : new Set<string>();
  const fresh = found.filter((u) => !have.has(`${u.symbol}|${u.day}`));
  let added = 0, thin = 0;
  const thinNames: string[] = [];
  if (fresh.length) {
    const bars = await data.getDailyBars(fresh.map((u) => u.symbol), addDays(today, -45), today, { feed: "sip" });
    const open = inSession(now);
    const snaps = open && data.getSnapshots ? await data.getSnapshots([...new Set([...fresh.map((u) => u.symbol), "SPY"])]).catch(() => ({} as Record<string, { price: number }>)) : {};
    for (const u of fresh) {
      const t = tradable(bars.filter((b) => b.symbol === u.symbol).sort((a, b) => a.date.localeCompare(b.date)), u.day);
      if (!t.ok) { thin++; thinNames.push(u.symbol); continue; }
      // Market open and a live price in hand: in now. Otherwise it waits for the next open.
      const price = open ? snaps[u.symbol]?.price ?? null : null;
      await q(
        `INSERT INTO upgrade_list (symbol, day, brokers, to_rating, from_rating, top_broker, headline, url, news_at, listed_at, prev_close, entry_date, entry_price, spy_entry, basis, exit_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (symbol, day) DO NOTHING`,
        [u.symbol, u.day, u.brokers, u.to, u.from, u.topBroker, u.headline.slice(0, 300), u.url, u.newsAt, now.toISOString(), t.prevClose, price ? today : null, price, price ? snaps.SPY?.price ?? null : null, price ? "listing" : "open", price ? addDays(today, UPGRADES.holdDays) : null],
      );
      added++;
    }
  }
  // More brokers on a stock already listed today: add their names (the entry stays).
  for (const u of found.filter((x) => have.has(`${x.symbol}|${x.day}`))) await q(`UPDATE upgrade_list SET brokers = (SELECT ARRAY(SELECT DISTINCT unnest(brokers || $3::text[]))), top_broker = top_broker OR $4 WHERE symbol = $1 AND day = $2`, [u.symbol, u.day, u.brokers, u.topBroker]).catch(() => undefined);
  await store.cachePut("upgrades:last", { at: now.toISOString() }).catch(() => undefined);
  const settled = await settle(data, now);
  const open = Number((await q(`SELECT count(*) AS n FROM upgrade_list WHERE exit_date IS NULL`))[0]?.n ?? 0);
  // How far back the headlines read actually reach (the stream gives the newest 1,000), and the latest listings by name.
  const oldest = news.reduce((m, n) => (n.ts < m ? n.ts : m), now.toISOString());
  const latest = (await q(`SELECT symbol, entry_price FROM upgrade_list ORDER BY news_at DESC LIMIT 8`).catch(() => [])).map((r) => `${r.symbol}${r.entry_price === null ? "" : ` $${Number(r.entry_price).toFixed(2)}`}`);
  return `upgrades: ${found.length} in the headlines since ${etLabel(since.toISOString())}, ${added} new${thin ? ` (${thin} too small or thinly traded: ${thinNames.slice(0, 8).join(", ")})` : ""}, ${settled.entered} entered at an open, ${settled.closed} closed · ${open} open · ${news.length} headlines read back to ${etLabel(oldest)} · latest: ${latest.join(", ") || "none"}`;
}

async function settle(data: MarketData, now: Date): Promise<{ entered: number; closed: number }> {
  const today = toEt(now).date;
  const due = (await q(`SELECT * FROM upgrade_list WHERE exit_date IS NULL AND (entry_date IS NULL OR exit_by < $1)`, [today])).map(toUpgrade);
  if (!due.length) return { entered: 0, closed: 0 };
  const from = addDays(due.reduce((m, u) => { const d = u.entryDate ?? u.day; return d < m ? d : m; }, today), -3);
  const all = await data.getDailyBars([...new Set(due.map((u) => u.symbol)), "SPY"], from, today, { feed: "sip" });
  const of = (sym: string) => all.filter((b) => b.symbol === sym).sort((a, b) => a.date.localeCompare(b.date));
  const spy = of("SPY");
  let entered = 0, closed = 0;
  for (const u of due) {
    const bars = of(u.symbol);
    if (!u.entryDate) {
      const x = openEntry(u.listedAt, openedBars(bars, now));
      if (!x) continue;
      await q(`UPDATE upgrade_list SET entry_date = $3, entry_price = $4, spy_entry = $5, exit_by = $6 WHERE symbol = $1 AND day = $2 AND entry_date IS NULL`, [u.symbol, u.day, x.date, x.price, spy.find((b) => b.date === x.date)?.o ?? null, addDays(x.date, UPGRADES.holdDays)]);
      entered++;
    } else if (u.exitBy) {
      const x = timeExit(u.exitBy, bars, today);
      if (!x) continue;
      await q(`UPDATE upgrade_list SET exit_date = $3, exit_price = $4, spy_exit = $5 WHERE symbol = $1 AND day = $2 AND exit_date IS NULL`, [u.symbol, u.day, x.date, x.price, spy.find((b) => b.date === x.date)?.c ?? null]);
      closed++;
    }
  }
  return { entered, closed };
}
