/**
 * Analyst coverage: how many analysts follow a stock, from Finnhub's free recommendation trends (the latest month's
 * strong buy + buy + hold + sell + strong sell). A rough count, not estimate revisions (those cost money). The
 * "Finding ideas before the crowd" research finds the edges strongest in thinly covered stocks, so cards show the
 * band and the scoreboard splits results by it. FINNHUB_API_KEY (free); without it coverage is "not known".
 */
import { query as q } from "../db";

export type CoverageBand = "low" | "moderate" | "high";
export const COVERAGE = { lowMax: 3, moderateMax: 10, refreshDays: 7 };

/** Pure: the band for an analyst count. */
export const coverageBand = (n: number | null): CoverageBand | null => (n === null ? null : n <= COVERAGE.lowMax ? "low" : n <= COVERAGE.moderateMax ? "moderate" : "high");

/** Pure: analysts in the latest month of Finnhub's recommendation trends. */
export function analystsFrom(rows: Array<{ period?: string; strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }>): { analysts: number; period: string } | null {
  const latest = rows.slice().sort((a, b) => (b.period ?? "").localeCompare(a.period ?? ""))[0];
  if (!latest) return null;
  return { analysts: (latest.strongBuy ?? 0) + (latest.buy ?? 0) + (latest.hold ?? 0) + (latest.sell ?? 0) + (latest.strongSell ?? 0), period: latest.period ?? "" };
}

export async function fetchCoverage(symbol: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<{ analysts: number; period: string }> {
  const key = env.FINNHUB_API_KEY?.trim();
  if (!key) throw new Error("FINNHUB_API_KEY not set");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetchImpl(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    const rows = (await res.json()) as Array<{ period?: string; strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }>;
    // No rows: no analyst follows it (Finnhub lists every covered stock).
    return analystsFrom(Array.isArray(rows) ? rows : []) ?? { analysts: 0, period: "" };
  } finally {
    clearTimeout(t);
  }
}

/** Stored coverage for symbols (null where never fetched). */
export async function coverageOf(symbols: string[]): Promise<Map<string, { analysts: number | null; band: CoverageBand | null; fetchedAt: string }>> {
  if (!symbols.length) return new Map();
  const rows = await q(`SELECT symbol, analysts, fetched_at FROM analyst_coverage WHERE symbol = ANY($1::text[])`, [symbols]).catch(() => []);
  return new Map(rows.map((r) => [String(r.symbol), { analysts: r.analysts === null ? null : Number(r.analysts), band: coverageBand(r.analysts === null ? null : Number(r.analysts)), fetchedAt: new Date(r.fetched_at as string).toISOString() }]));
}

/** Fetch coverage for symbols never fetched or older than a week (at most `max` calls; Finnhub's free tier allows 60 a minute). */
export async function refreshCoverage(symbols: string[], env: NodeJS.ProcessEnv, max = 20, fetchImpl?: typeof fetch): Promise<number> {
  if (!env.FINNHUB_API_KEY?.trim() || !symbols.length) return 0;
  const have = await coverageOf(symbols);
  const stale = [...new Set(symbols)].filter((s) => { const h = have.get(s); return !h || Date.now() - Date.parse(h.fetchedAt) > COVERAGE.refreshDays * 86400_000; }).slice(0, max);
  let n = 0;
  for (const s of stale) {
    try {
      const c = await fetchCoverage(s, env, fetchImpl);
      await q(`INSERT INTO analyst_coverage (symbol, analysts, period, fetched_at) VALUES ($1, $2, $3, now()) ON CONFLICT (symbol) DO UPDATE SET analysts = EXCLUDED.analysts, period = EXCLUDED.period, fetched_at = now()`, [s, c.analysts, c.period]);
      n++;
    } catch (e) {
      if (e instanceof Error && / 429/.test(e.message)) break;
    }
  }
  return n;
}
