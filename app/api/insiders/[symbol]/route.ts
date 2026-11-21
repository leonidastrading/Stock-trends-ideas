import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The insiders' open-market buys and sales at a company (two years, from the SEC), for the insider chart. Kept 6 hours. */
export async function GET(request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { symbol: raw } = await ctx.params;
  const symbol = raw.toUpperCase();
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) return NextResponse.json({ error: "not a ticker" }, { status: 422 });
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!hasDatabase() || !ua) return NextResponse.json({ error: "SEC_USER_AGENT or the database is not set" }, { status: 503 });
  const store = await import("@/lib/scout/store");
  const key = `insiders:${symbol}`;
  const cached = await store.cacheGet<unknown>(key).catch(() => null);
  if (cached && Date.now() - Date.parse(cached.updatedAt) < 6 * 3600_000) return NextResponse.json(cached.data);
  try {
    const { insiderTradesFor } = await import("@/lib/scout/insider-history");
    const out = { symbol, ...(await insiderTradesFor(symbol, ua)) };
    await store.cachePut(key, out).catch(() => undefined);
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, { status: 500 });
  }
}
