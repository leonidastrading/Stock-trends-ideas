import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { runDaily } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily scan: once a weekday at midday ET, when the EDGAR relay on the home computer is up (Vercel cron, Authorization: Bearer CRON_SECRET). */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runDaily());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`daily run failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
