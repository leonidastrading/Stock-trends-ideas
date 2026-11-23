import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { fundamentals } from "@/lib/sources/fmp";
import { toEt } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A stock's income statement and EPS vs estimate (Financial Modeling Prep), for the cards' charts. ?period=annual|quarter */
export async function GET(request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sym = decodeURIComponent((await ctx.params).symbol).toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) return NextResponse.json({ error: "bad symbol" }, { status: 422 });
  const period = new URL(request.url).searchParams.get("period") === "quarter" ? "quarter" : "annual";
  return NextResponse.json(await fundamentals(sym, period, toEt(new Date()).date), { headers: { "cache-control": "private, max-age=600" } });
}
