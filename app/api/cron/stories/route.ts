import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { runStoriesJob } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Story desk: call hourly (e.g. cron-job.org, Authorization: Bearer CRON_SECRET). A story's trades are researched once per 3 days. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runStoriesJob());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`stories run failed: ${message}`);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
