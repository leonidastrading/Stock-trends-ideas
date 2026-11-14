import { after, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { runStoriesJob } from "@/lib/scout/engine";
import * as store from "@/lib/scout/store";

/** A scheduler set to every few minutes would re-read the same headlines all day: one scan per 45 minutes is plenty. */
const MIN_INTERVAL_MIN = 45;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Story desk, meant to be called hourly by an outside scheduler (cron-job.org).
 * Replies 202 at once and runs the scan after the response, so the scheduler's
 * short timeout doesn't cut it off; the result lands in Settings → Recent runs.
 * Add ?wait=1 to run in the foreground and get the result in the reply.
 * A story's trades are researched once per 3 days. Calls within 45 minutes of the last scan are
 * answered "throttled" and do nothing, so a scheduler set too often costs nothing.
 */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  if (params.get("force") !== "1") {
    const last = await store.lastStarted("stories").catch(() => null);
    const ago = last ? (Date.now() - Date.parse(last)) / 60000 : Infinity;
    if (ago < MIN_INTERVAL_MIN) return NextResponse.json({ status: "throttled", note: `last story scan started ${Math.round(ago)} min ago; one per ${MIN_INTERVAL_MIN} min (add ?force=1 to override)` });
  }
  if (params.get("wait") === "1") {
    try {
      return NextResponse.json(await runStoriesJob());
    } catch (err) {
      return NextResponse.json({ status: "error", error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }
  after(async () => {
    try {
      await runStoriesJob();
    } catch (err) {
      console.error(`stories run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return NextResponse.json({ status: "started", note: "story scan running in the background; see Settings → Recent runs" }, { status: 202 });
}
