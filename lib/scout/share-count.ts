/**
 * The share count: is the company buying itself back, or issuing?
 *
 * Why: a short on a company that keeps retiring its own shares fights a standing buyer, and every share retired
 * makes the short a larger part of what is left to borrow and buy back. Bill Ackman was right about Herbalife and
 * lost about a billion dollars on it (2012 to 2018): the company borrowed to buy its own shares, a large holder took
 * more off the market, and his short went from a fifth to over a third of the shares that could trade. The scout
 * checked short interest but never looked at buybacks. The mirror matters for longs: a count that grows fast is
 * dilution.
 *
 * From the SEC's own data (XBRL): the shares outstanding on the cover of each 10-Q and 10-K, and what the cash-flow
 * statement says was paid for repurchases in the last fiscal year. Measured by code, no AI. Changing what research
 * is told here changes research input: bump SHARE_COUNT_REVISION (it is part of the scout's version).
 */
import { getJson, HttpError } from "../http";
import { secTickerList } from "../sources/edgar";
import * as store from "./store";

export const SHARE_COUNT_REVISION = 1;
export const SHARE_COUNT = { keepDays: 3, shrinking: -3, growing: 10, splitLike: 40, crowdedShortPct: 10 };

export interface SharePoint { end: string; val: number; accn?: string; filed?: string; form?: string; fp?: string; fy?: number }
export interface ShareTrend {
  symbol: string; at: string;
  shares: number; asOf: string;
  /** Change in the share count over about one and three years, in percent (null when no filing that far back). */
  yr1Pct: number | null; yr3Pct: number | null;
  /** Paid for the company's own shares in its last full fiscal year (cash-flow statement), when it reports one. */
  buyback: { usd: number; fy: string } | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000;

/**
 * Pure: the share count now and a year and three years back. A company with several share classes reports one
 * number per class on the same cover: the classes of one filing are added up.
 */
export function shareTrendFrom(points: SharePoint[]): Pick<ShareTrend, "shares" | "asOf" | "yr1Pct" | "yr3Pct"> | null {
  const byEnd = new Map<string, { filed: string; accn: string; vals: Set<number> }>();
  for (const p of points) {
    if (!(p.val > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(p.end)) continue;
    const cur = byEnd.get(p.end), filed = p.filed ?? "", accn = p.accn ?? "";
    // The latest filing that states the count for this date wins; within it, each class once.
    if (!cur || filed > cur.filed) byEnd.set(p.end, { filed, accn, vals: new Set([p.val]) });
    else if (accn === cur.accn) cur.vals.add(p.val);
  }
  const series = [...byEnd.entries()].map(([end, v]) => ({ end, val: [...v.vals].reduce((a, b) => a + b, 0) })).sort((a, b) => a.end.localeCompare(b.end));
  const last = series.at(-1);
  if (!last) return null;
  const back = (years: number, slack: number) => {
    const want = new Date(Date.parse(`${last.end}T00:00:00Z`) - years * 365.25 * 86400_000).toISOString().slice(0, 10);
    const near = series.filter((s) => s.end < last.end && days(s.end, want) <= slack).sort((a, b) => days(a.end, want) - days(b.end, want))[0];
    return near ? r1((last.val / near.val - 1) * 100) : null;
  };
  return { shares: last.val, asOf: last.end, yr1Pct: back(1, 60), yr3Pct: back(3, 100) };
}

/** Pure: what was paid for repurchases in the last full fiscal year (the 10-K's own figure). */
export function lastBuyback(points: SharePoint[]): ShareTrend["buyback"] {
  const fy = points.filter((p) => p.form === "10-K" && p.fp === "FY" && p.val >= 0).sort((a, b) => a.end.localeCompare(b.end) || (a.filed ?? "").localeCompare(b.filed ?? "")).at(-1);
  return fy && fy.val > 0 ? { usd: fy.val, fy: fy.end.slice(0, 4) } : null;
}

const count = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${Math.round(n / 1e6)}M`);
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}%`;

/** Pure: "shrinking", "growing", "split" (a jump too large to be buybacks or ordinary issuance) or "steady". */
export function shareVerdict(t: Pick<ShareTrend, "yr1Pct">): "shrinking" | "growing" | "split" | "steady" | "unknown" {
  if (t.yr1Pct === null) return "unknown";
  if (Math.abs(t.yr1Pct) >= SHARE_COUNT.splitLike) return "split";
  return t.yr1Pct <= SHARE_COUNT.shrinking ? "shrinking" : t.yr1Pct >= SHARE_COUNT.growing ? "growing" : "steady";
}

/** Pure: the block research is given. `shortPct`: % of the float sold short, when known. */
export function shareCountText(t: ShareTrend, shortPct: number | null = null, marketCap: number | null = null): string {
  const v = shareVerdict(t);
  const head = `SHARE COUNT (the SEC's own data, measured by the scout's code; not a source): ${t.symbol} had ${count(t.shares)} shares at ${t.asOf}${t.yr1Pct !== null ? `, ${signed(t.yr1Pct)} in a year` : ""}${t.yr3Pct !== null ? `, ${signed(t.yr3Pct)} in three years` : ""}.`;
  const bb = t.buyback ? ` It paid ${usd(t.buyback.usd)} for its own shares in fiscal ${t.buyback.fy}${marketCap ? `, about ${r1((t.buyback.usd / marketCap) * 100)}% of today's market value` : ""}.` : "";
  const read = v === "shrinking"
    ? ` The company is shrinking its own share count. For a short that is a headwind that does not go away: a steady buyer under the price, and fewer shares left to borrow and buy back${shortPct !== null && shortPct >= SHARE_COUNT.crowdedShortPct ? `, with ${shortPct}% of the float already sold short (the setup that cost short sellers of Herbalife dearly even though they were right about the business)` : ""}. A short here needs a dated catalyst, not only a bad business; say this under the risks, and prefer puts or no trade when short interest is high.`
    : v === "growing" ? " The share count is growing fast: the company is issuing shares (dilution), a headwind for a long and a reason holders' share of the business shrinks."
      : v === "split" ? " A change this large is a stock split, a merger or a large issue, not buybacks: do not read it as either." : "";
  return `${head}${bb}${read}`;
}

interface Concept { units?: Record<string, SharePoint[]> }

/** The stock's share trend, from the cache or the SEC (two small requests). Null when the company is not in the SEC's data. */
export async function shareTrend(symbol: string, env: NodeJS.ProcessEnv = process.env, now = new Date(), fetchImpl?: typeof fetch): Promise<ShareTrend | null> {
  const key = `share-count:${symbol}`;
  const hit = await store.cacheGet<ShareTrend | { none: true }>(key).catch(() => null);
  if (hit && now.getTime() - Date.parse(hit.updatedAt) < SHARE_COUNT.keepDays * 86400_000) return "none" in hit.data ? null : hit.data;
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return null;
  const cik = (await secTickerList(ua, fetchImpl)).find((t) => t.ticker === symbol)?.cik;
  const concept = async (taxonomy: string, tag: string) => {
    try {
      return await getJson<Concept>(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik!.padStart(10, "0")}/${taxonomy}/${tag}.json`, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 150, cacheMs: 12 * 3600_000, fetchImpl, retries: 1, timeoutMs: 15_000 });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  };
  if (!cik) { await store.cachePut(key, { none: true }).catch(() => undefined); return null; }
  const shares = await concept("dei", "EntityCommonStockSharesOutstanding");
  const trend = shareTrendFrom(shares?.units?.shares ?? []);
  if (!trend) { await store.cachePut(key, { none: true }).catch(() => undefined); return null; }
  const paid = await concept("us-gaap", "PaymentsForRepurchaseOfCommonStock").catch(() => null);
  const out: ShareTrend = { symbol, at: now.toISOString(), ...trend, buyback: lastBuyback(paid?.units?.USD ?? []) };
  await store.cachePut(key, out).catch(() => undefined);
  return out;
}

/** The share trend already on file (no request): for the card's chip. */
export async function shareTrendOnFile(symbol: string): Promise<ShareTrend | null> {
  const hit = await store.cacheGet<ShareTrend | { none: true }>(`share-count:${symbol}`).catch(() => null);
  return hit && !("none" in hit.data) ? hit.data : null;
}

/** The block for research; null when nothing is known. Never throws. */
export async function shareCountLine(symbol: string | undefined, shortPct: number | null, marketCap: number | null, env: NodeJS.ProcessEnv, now: Date, fetchImpl?: typeof fetch): Promise<string | null> {
  if (!symbol) return null;
  try {
    const t = await shareTrend(symbol, env, now, fetchImpl);
    return t ? shareCountText(t, shortPct, marketCap) : null;
  } catch {
    return null;
  }
}
