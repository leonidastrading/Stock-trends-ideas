/**
 * Cboe's free delayed option chains (cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json,
 * checked from Vercel's network on 2026-11-14): every listed contract with bid, ask, implied volatility,
 * volume and open interest, plus the stock's last price. Open interest is the count of contracts still
 * open at the previous close (the OCC publishes it before the open), so a day's new positions show up
 * in the next day's chain. No key needed.
 */
import { getText } from "../http";

const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "application/json" };

export interface OptionContract { contract: string; type: "call" | "put"; strike: number; expiry: string; oi: number; volume: number; mid: number | null; iv?: number | null; gamma?: number | null }
export interface Chain { symbol: string; spot: number; asOf: string; contracts: OptionContract[] }

/** Pure: the standard contracts of one chain (root = the stock's symbol; adjusted roots such as B1VDA are skipped). */
export function parseChain(json: unknown, symbol: string): Chain | null {
  const d = (json as { data?: { current_price?: number; last_trade_time?: string | null; options?: Array<Record<string, unknown>> } })?.data;
  if (!d?.current_price || !Array.isArray(d.options)) return null;
  const re = new RegExp(`^${symbol.replace(".", "\\.")}(\\d{2})(\\d{2})(\\d{2})([CP])(\\d{8})$`);
  const contracts: OptionContract[] = [];
  for (const o of d.options) {
    const m = String(o.option ?? "").match(re);
    if (!m) continue;
    const bid = Number(o.bid ?? 0), ask = Number(o.ask ?? 0);
    contracts.push({
      contract: String(o.option), type: m[4] === "C" ? "call" : "put", strike: Number(m[5]) / 1000, expiry: `20${m[1]}-${m[2]}-${m[3]}`,
      oi: Math.round(Number(o.open_interest ?? 0)), volume: Math.round(Number(o.volume ?? 0)), mid: ask > 0 ? (bid + ask) / 2 : Number(o.last_trade_price ?? 0) || null,
      // iv is a decimal (0.20 = 20%); options expiring today can show 8+ (800%).
      iv: Number(o.iv) > 0 ? Number(o.iv) : null, gamma: Number.isFinite(Number(o.gamma)) && o.gamma !== null && o.gamma !== undefined ? Number(o.gamma) : null,
    });
  }
  return { symbol, spot: d.current_price, asOf: String(d.last_trade_time ?? "").slice(0, 10), contracts };
}

export async function optionChain(symbol: string, fetchImpl?: typeof fetch): Promise<Chain | null> {
  const body = await getText(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`, { headers: BROWSER, fetchImpl, cacheMs: 0, minIntervalMs: 150, timeoutMs: 30000 });
  return parseChain(JSON.parse(body), symbol);
}
