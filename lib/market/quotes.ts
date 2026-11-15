/**
 * Current price and the move since the previous close, for card headers. Cards on one page ask at about the
 * same time; their requests are gathered into one Alpaca snapshot call and kept for a minute. A slow or failed
 * call shows no price rather than holding up the page.
 */
import { marketDataFromEnv, type MarketData, type Snapshot } from "../alpaca";
import { toEt } from "../time";

export interface Quote { price: number; changePct: number | null; at: string | null; sessionDate: string | null }

/** Pure: a snapshot as a quote (change against the previous session's close). */
export function toQuote(s: Snapshot): Quote {
  return { price: s.price, changePct: s.prevClose ? Math.round((s.price / s.prevClose - 1) * 10000) / 100 : null, at: s.at, sessionDate: s.sessionDate };
}

/** Pure: "today" when the price is from today's session (ET), else the session's weekday, e.g. "Fri". */
export function sessionLabel(q: Quote, now = new Date()): string {
  if (!q.sessionDate) return "";
  if (q.sessionDate === toEt(now).date) return "today";
  return new Date(`${q.sessionDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

const cache = new Map<string, { at: number; q: Quote | null }>();
let pending: Map<string, Array<(q: Quote | null) => void>> | null = null;
let source: () => MarketData | null = () => marketDataFromEnv();

export function setQuoteSourceForTests(f: (() => MarketData | null) | null): void {
  source = f ?? (() => marketDataFromEnv());
  cache.clear();
}

async function flush(batch: Map<string, Array<(q: Quote | null) => void>>) {
  let snaps: Record<string, Snapshot> = {};
  try {
    const data = source();
    if (data?.getSnapshots) snaps = await data.getSnapshots([...batch.keys()]);
  } catch {
    /* no prices this time */
  }
  for (const [sym, waiting] of batch) {
    const q = snaps[sym] ? toQuote(snaps[sym]) : null;
    cache.set(sym, { at: Date.now(), q });
    for (const resolve of waiting) resolve(q);
  }
}

/** The quote for one symbol; null if unavailable or slower than `timeoutMs`. */
export function quote(symbol: string, timeoutMs = 2500): Promise<Quote | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.q);
  const p = new Promise<Quote | null>((resolve) => {
    if (!pending) {
      pending = new Map();
      setTimeout(() => { const b = pending!; pending = null; void flush(b); }, 20);
    }
    pending.set(symbol, [...(pending.get(symbol) ?? []), resolve]);
  });
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
}
