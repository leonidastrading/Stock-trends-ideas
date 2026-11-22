import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { marketDataFromEnv, type DailyBar } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { panel } from "@/lib/market/panels";
import { fetchEarningsDates } from "@/lib/sources/edgar";
import * as store from "@/lib/scout/store";
import { addDays, toEt } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Two years of daily bars and the earnings-release dates (SEC 8-K item 2.02) for the scout's own chart. */
export async function GET(request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sym = decodeURIComponent((await ctx.params).symbol).toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) return NextResponse.json({ error: "bad symbol" }, { status: 422 });
  const data = marketDataFromEnv();
  if (!data || !hasDatabase()) return NextResponse.json({ error: "market data not configured" }, { status: 503 });
  const today = toEt(new Date()).date;
  const ua = process.env.SEC_USER_AGENT?.trim();
  const [bars, earn, info] = await Promise.all([
    panel<{ bars: DailyBar[]; raw: Array<[string, number, number]>; feed: string }>(`chartbars2:${sym}`, 30, async () => {
      const from = addDays(today, -760);
      // Whole-market bars (the free plan allows them up to 15 minutes ago), else IEX alone.
      const [sip, raw, iex] = await Promise.all([
        data.getDailyBars([sym], from, today, { feed: "sip" }).catch(() => null),
        data.getDailyBars([sym], from, today, { feed: "sip", adjustment: "raw" }).catch(() => null),
        data.getDailyBars([sym], addDays(today, -5), today),
      ]);
      const mine = (b: DailyBar[] | null) => (b ?? []).filter((x) => x.symbol === sym);
      if (!sip?.length) return { bars: mine(await data.getDailyBars([sym], from, today)), raw: [], feed: "iex" };
      const have = new Set(mine(sip).map((b) => b.date));
      return { bars: [...mine(sip), ...mine(iex).filter((b) => !have.has(b.date))], raw: mine(raw).map((b) => [b.date, b.c, b.v] as [string, number, number]), feed: "sip" };
    }, 25_000),
    // A failed SEC lookup is not cached (it used to be kept as "no earnings" for 12 hours, leaving the chart without lines).
    ua ? panel<string[]>(`earndates:${sym}`, 12 * 60, async () => { const d = await fetchEarningsDates(sym, addDays(today, -800), ua); if (d === null) throw new Error("SEC lookup failed"); return d; }, 15_000) : Promise.resolve({ data: [] as string[], error: null }),
    store.symbolInfo([sym]).then((m) => m.get(sym) ?? null).catch(() => null),
  ]);
  if (!bars.data?.bars.length) return NextResponse.json({ error: bars.error ?? "no bars" }, { status: 502 });
  // Plus the dates already on file, so a slow or failed SEC lookup still draws the past releases.
  const onFile = await store.earningsDatesFor(sym).catch(() => [] as string[]);
  // Finnhub's calendar too (foreign companies report on 6-K, which the SEC source does not read). Not cached when it fails.
  const finn = process.env.FINNHUB_API_KEY?.trim()
    ? await panel<string[]>(`earndates-fh:${sym}`, 12 * 60, async () => { const d = await import("@/lib/sources/earnings-data").then(({ finnhubEarningsDates }) => finnhubEarningsDates(sym, addDays(today, -760), today)); if (d === null) throw new Error("no key"); return d; }, 8_000)
    : { data: [] as string[] };
  const earnings = [...new Set([...(earn.data ?? []), ...onFile, ...(finn.data ?? [])])].sort();
  const next = info?.nextEarnings && info.nextEarnings >= today ? info.nextEarnings : null;
  // The company's name (for the chart's background) and the latest pre-market or after-hours trade.
  const [name, q] = await Promise.all([
    info?.name ? Promise.resolve(info.name) : (data.getAsset?.(sym) ?? Promise.resolve(null)).then((a) => a?.name ?? null).catch(() => null),
    import("@/lib/market/quotes").then(({ quote }) => quote(sym, 4000)).catch(() => null),
  ]);
  const ext = q && q.extPct !== null && q.extPct !== undefined ? { price: q.price, pct: q.extPct, label: q.extLabel ?? "after hours", at: q.at } : null;
  return NextResponse.json({
    symbol: sym,
    bars: bars.data.bars.map((b) => [b.date, b.o, b.h, b.l, b.c, b.v]),
    raw: bars.data.raw, feed: bars.data.feed,
    earnings,
    next, nextBasis: next ? info?.nextBasis ?? null : null,
    name, ext,
  }, { headers: { "cache-control": "private, max-age=120" } });
}
