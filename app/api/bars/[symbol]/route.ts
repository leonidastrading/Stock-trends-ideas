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
    panel<DailyBar[]>(`chartbars:${sym}`, 30, () => data.getDailyBars([sym], addDays(today, -760), today), 20_000),
    ua ? panel<string[]>(`earndates:${sym}`, 12 * 60, async () => (await fetchEarningsDates(sym, addDays(today, -800), ua)) ?? [], 15_000) : Promise.resolve({ data: [] as string[], error: null }),
    store.symbolInfo([sym]).then((m) => m.get(sym) ?? null).catch(() => null),
  ]);
  if (!bars.data?.length) return NextResponse.json({ error: bars.error ?? "no bars" }, { status: 502 });
  const next = info?.nextEarnings && info.nextEarnings >= today ? info.nextEarnings : null;
  return NextResponse.json({
    symbol: sym,
    bars: bars.data.filter((b) => b.symbol === sym).map((b) => [b.date, b.o, b.h, b.l, b.c, b.v]),
    earnings: earn.data ?? [],
    next, nextBasis: next ? info?.nextBasis ?? null : null,
  }, { headers: { "cache-control": "private, max-age=300" } });
}
