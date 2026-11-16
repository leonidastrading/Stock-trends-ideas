/**
 * A stock's size and short interest, for the card header: market cap (Nasdaq's stock summary, else Schwab's shares
 * outstanding × price) and short interest (FINRA, else Nasdaq; % of float from Schwab when connected).
 * Cached 12 hours per stock; short interest itself only changes twice a month.
 */
import { getText } from "../http";
import { shortData, type ShortData } from "./short";
import { panel } from "./panels";

export interface StockProfile { marketCap: number | null; capSource: string | null; short: ShortData | null; shortError: string | null }

const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "application/json, text/plain, */*" };

/** Pure: the market cap from Nasdaq's stock summary ("4,301,234,567"), or null. */
export function parseNasdaqCap(json: unknown): number | null {
  const s = (json as { data?: { summaryData?: Record<string, { value?: unknown }> } })?.data?.summaryData;
  const v = s?.MarketCap?.value ?? s?.marketCap?.value;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pure: "$1.2B", "$850M", "$2.1T". */
export function fmtCap(v: number | null): string | null {
  if (v === null || !Number.isFinite(v) || v <= 0) return null;
  return v >= 1e12 ? `$${(v / 1e12).toFixed(1)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${Math.round(v / 1e3)}k`;
}

/** Pure: the size bucket traders use. */
export function capBucket(v: number | null): string | null {
  if (v === null) return null;
  return v >= 200e9 ? "mega cap" : v >= 10e9 ? "large cap" : v >= 2e9 ? "mid cap" : v >= 300e6 ? "small cap" : v >= 50e6 ? "micro cap" : "nano cap";
}

async function nasdaqCap(symbol: string, fetchImpl?: typeof fetch): Promise<number | null> {
  const body = await getText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetClass=stocks`, { headers: BROWSER, fetchImpl, cacheMs: 12 * 3600_000, minIntervalMs: 400, timeoutMs: 8000, retries: 1 });
  return parseNasdaqCap(JSON.parse(body));
}

/** Pure: put the two lookups together. */
export function buildProfile(cap: number | null, short: ShortData | null, shortError: string | null, price: number | null): StockProfile {
  const fromShares = cap === null && price && short?.sharesOutstanding ? short.sharesOutstanding * price : null;
  return { marketCap: cap ?? fromShares, capSource: cap !== null ? "Nasdaq" : fromShares !== null ? "Schwab shares × price" : null, short, shortError };
}

export async function stockProfile(symbol: string, price: number | null, fetchImpl?: typeof fetch): Promise<StockProfile | null> {
  const p = await panel<StockProfile>(`profile:${symbol}`, 12 * 60, async () => {
    const [cap, short] = await Promise.all([
      nasdaqCap(symbol, fetchImpl).catch(() => null),
      shortData([symbol], fetchImpl).catch(() => null),
    ]);
    return buildProfile(cap, short?.get(symbol) ?? null, short?.errors?.get(symbol) ?? null, price);
  }, 12_000);
  return p.data;
}
