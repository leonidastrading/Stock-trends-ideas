import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { runDaily, runTrack } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "Run now" from the Settings page: the same jobs the cron calls, behind the dashboard login. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { job?: string };
  try {
    if (body.job === "track") return NextResponse.json({ ok: true, result: await runTrack() });
    if (body.job === "daily") return NextResponse.json({ ok: true, result: await runDaily() });
    return NextResponse.json({ ok: false, errors: ["job must be 'daily' or 'track'"] }, { status: 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
