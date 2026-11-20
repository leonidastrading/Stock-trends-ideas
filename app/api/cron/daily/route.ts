import { NextResponse } from "next/server";
import { background } from "@/lib/background";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { runDaily } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily scan: once a weekday at midday ET, when the EDGAR relay on the home computer is up (Vercel cron, Authorization: Bearer CRON_SECRET). */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    console.warn(`cron auth refused ${new URL(request.url).pathname}: ${why.detail}`);
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  background(() => import("@/lib/scout/catchup").then(({ catchUp }) => catchUp(120_000)));
  try {
    return NextResponse.json(await runDaily());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`daily run failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
