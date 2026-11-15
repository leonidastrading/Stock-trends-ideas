import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { cleanSymbol, lookupTicker } from "@/lib/scout/lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Home-page ticker search. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const symbol = cleanSymbol(new URL(request.url).searchParams.get("symbol") ?? "");
  if (!symbol) return NextResponse.json({ ok: false, errors: ["type a ticker, like NVDA"] }, { status: 422 });
  return NextResponse.json({ ok: true, result: await lookupTicker(symbol) });
}
