import { NextResponse } from "next/server";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { runTrack } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** After the close: ingest daily bars and move every paper track forward. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    console.warn(`cron auth refused ${new URL(request.url).pathname}: ${why.detail}`);
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  try {
    return NextResponse.json(await runTrack());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`track run failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
