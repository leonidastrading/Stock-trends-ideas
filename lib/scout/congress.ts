/**
 * Congress trades: House members' periodic transaction reports, read from the
 * Clerk's site (lib/sources/house.ts), stored append-only, and summarised:
 * which stocks several members bought, who trades most, and how their buys did
 * since the trade date (what the member got) and since the filing date (what
 * anyone reading the report could have got; reports may come up to 45 days late).
 */
import { type DailyBar, type MarketData } from "../alpaca";
import { houseIndex, housePtrPdf, isScanned, parsePtrText, type HouseFiling } from "../sources/house";
import { addDays, daysBetween, toEt } from "../time";
import * as store from "./store";
import type { CongressTradeRow } from "./store";

export const CONGRESS_LOOKBACK_DAYS = 120;

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

/** Pure: reports not read yet, filed within the look-back, newest first. */
export function pickReports(filings: HouseFiling[], seen: Set<string>, today: string, lookbackDays = CONGRESS_LOOKBACK_DAYS): HouseFiling[] {
  const from = addDays(today, -lookbackDays);
  return filings.filter((f) => !seen.has(f.docId) && f.filed >= from && f.filed <= today).sort((a, b) => b.filed.localeCompare(a.filed) || b.docId.localeCompare(a.docId));
}

/** Housekeeping slice: read new House reports until the deadline (each one stored with its trades, or as scanned / failed). */
export async function pollHouse(deadline: number, now = new Date(), fetchImpl: typeof fetch = fetch, max = 40) {
  const today = toEt(now).date;
  const year = Number(today.slice(0, 4));
  const filings = [...(await houseIndex(year, fetchImpl))];
  if (Number(today.slice(5, 7)) <= 2) filings.push(...(await houseIndex(year - 1, fetchImpl).catch(() => [])));
  const todo = pickReports(filings, await store.congressSeen(), today);
  let read = 0, trades = 0, scanned = 0, errors = 0;
  for (const f of todo.slice(0, max)) {
    if (Date.now() > deadline) break;
    const base = { docId: f.docId, chamber: "House", member: f.member, stateDst: f.stateDst || null, filed: f.filed, year: f.year };
    try {
      const text = await pdfText(await housePtrPdf(f, fetchImpl));
      if (isScanned(text)) {
        scanned++;
        await store.addCongressFiling({ ...base, status: "scanned (paper filing, no text layer)" }, []);
      } else {
        const rows = parsePtrText(text).map((t): CongressTradeRow => ({ ...base, ...t, stateDst: base.stateDst }));
        trades += rows.length;
        await store.addCongressFiling({ ...base, status: rows.length ? "read" : "read (no listed stocks)" }, rows);
      }
      read++;
    } catch (err) {
      // A report that cannot be fetched is retried next time unless it is clearly gone.
      errors++;
      if (/\b404\b/.test(String(err))) await store.addCongressFiling({ ...base, status: "error: report not found" }, []);
    }
  }
  return { indexed: filings.length, waiting: todo.length, read, trades, scanned, errors };
}

// ---------------------------------------------------------------- signals

export const midpoint = (t: { amountLow: number | null; amountHigh: number | null }) => (t.amountLow === null ? 0 : t.amountHigh === null ? t.amountLow : (t.amountLow + t.amountHigh) / 2);
const isBuy = (t: { tx: string }) => t.tx === "buy";
const isSell = (t: { tx: string }) => t.tx === "sell" || t.tx === "partial sale";

export interface SymbolActivity { symbol: string; buyers: string[]; sellers: string[]; buys: number; sells: number; buyUsd: number; sellUsd: number; lastFiled: string; cluster: boolean }

/** Pure: per stock, over reports filed since `from` (when the trades became public): who bought, who sold, rough dollars (range midpoints). */
export function bySymbol(trades: CongressTradeRow[], from: string): SymbolActivity[] {
  const m = new Map<string, SymbolActivity>();
  for (const t of trades) {
    if (t.filed < from || t.assetType !== "stock") continue;
    const a = m.get(t.symbol) ?? { symbol: t.symbol, buyers: [], sellers: [], buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, lastFiled: t.filed, cluster: false };
    if (isBuy(t)) { a.buys++; a.buyUsd += midpoint(t); if (!a.buyers.includes(t.member)) a.buyers.push(t.member); }
    if (isSell(t)) { a.sells++; a.sellUsd += midpoint(t); if (!a.sellers.includes(t.member)) a.sellers.push(t.member); }
    if (t.filed > a.lastFiled) a.lastFiled = t.filed;
    m.set(t.symbol, a);
  }
  const out = [...m.values()].filter((a) => a.buys + a.sells > 0);
  // A cluster: three or more members buying, or two buying at least $100k between them, with fewer members selling.
  for (const a of out) a.cluster = (a.buyers.length >= 3 || (a.buyers.length >= 2 && a.buyUsd >= 100_000)) && a.sellers.length < a.buyers.length;
  return out.sort((x, y) => y.buyers.length - x.buyers.length || y.buyUsd - x.buyUsd);
}

export interface MemberActivity { member: string; stateDst: string | null; trades: number; buys: number; sells: number; tradedUsd: number; lastFiled: string; medianLagDays: number | null; reports: number }

/** Pure: per member: how much they trade and how late they report (days from trade to filing). */
export function byMember(trades: CongressTradeRow[]): MemberActivity[] {
  const m = new Map<string, MemberActivity & { lags: number[]; docs: Set<string> }>();
  for (const t of trades) {
    const a = m.get(t.member) ?? { member: t.member, stateDst: t.stateDst, trades: 0, buys: 0, sells: 0, tradedUsd: 0, lastFiled: t.filed, medianLagDays: null, reports: 0, lags: [], docs: new Set<string>() };
    a.trades++;
    if (isBuy(t)) a.buys++;
    if (isSell(t)) a.sells++;
    a.tradedUsd += midpoint(t);
    a.lags.push(daysBetween(t.txDate, t.filed));
    a.docs.add(t.docId);
    if (t.filed > a.lastFiled) a.lastFiled = t.filed;
    m.set(t.member, a);
  }
  return [...m.values()].map(({ lags, docs, ...a }) => {
    const s = lags.sort((x, y) => x - y);
    return { ...a, reports: docs.size, medianLagDays: s.length ? s[Math.floor(s.length / 2)] : null };
  }).sort((x, y) => y.trades - x.trades);
}

// ------------------------------------------------------------ performance

export interface BuyResult { docId: string; ord: number; member: string; symbol: string; txDate: string; filed: string; amount: string; sinceTrade: number | null; sinceTradeVsSpy: number | null; sinceFiling: number | null; sinceFilingVsSpy: number | null; asOf: string | null }

/** Pure: first close on or after `date`, and the latest close. */
function closeOnOrAfter(bars: DailyBar[], date: string): number | null {
  for (const b of bars) if (b.date >= date) return b.c;
  return null;
}

/** Pure: each buy's return since the trade date and since the filing date, and the same against SPY, in percent. */
export function buyResults(buys: CongressTradeRow[], bars: Map<string, DailyBar[]>): BuyResult[] {
  const spy = bars.get("SPY") ?? [];
  const spyLast = spy.at(-1)?.c ?? null;
  const ret = (s: DailyBar[], from: string) => { const a = closeOnOrAfter(s, from), z = s.at(-1)?.c ?? null; return a && z ? (z / a - 1) * 100 : null; };
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return buys.map((t) => {
    const s = bars.get(t.symbol) ?? [];
    const st = ret(s, t.txDate), sf = ret(s, t.filed);
    const spt = spyLast ? ret(spy, t.txDate) : null, spf = spyLast ? ret(spy, t.filed) : null;
    return { docId: t.docId, ord: t.ord, member: t.member, symbol: t.symbol, txDate: t.txDate, filed: t.filed, amount: t.amount, asOf: s.at(-1)?.date ?? null,
      sinceTrade: r1(st), sinceTradeVsSpy: st !== null && spt !== null ? r1(st - spt) : null, sinceFiling: r1(sf), sinceFilingVsSpy: sf !== null && spf !== null ? r1(sf - spf) : null };
  });
}

/** Stock buys filed in the look-back, priced with Alpaca daily bars (one batched call). */
export async function congressPerformance(data: MarketData, now: Date): Promise<BuyResult[]> {
  const today = toEt(now).date;
  const buys = (await store.congressTradesSince(addDays(today, -CONGRESS_LOOKBACK_DAYS))).filter((t) => isBuy(t) && t.assetType === "stock");
  if (!buys.length) return [];
  const from = buys.reduce((a, t) => (t.txDate < a ? t.txDate : a), today);
  const symbols = [...new Set(buys.map((t) => t.symbol)), "SPY"];
  const rows = await data.getDailyBars(symbols, addDays(from, -3), today);
  const bars = new Map<string, DailyBar[]>();
  for (const b of rows.sort((a, c) => a.date.localeCompare(c.date))) bars.set(b.symbol, [...(bars.get(b.symbol) ?? []), b]);
  return buyResults(buys, bars);
}
