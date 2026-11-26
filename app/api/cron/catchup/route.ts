import { NextResponse } from "next/server";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Work the wait queue now, in this call's own 5 minutes (started by an upload whose later ideas are in line, so they
 * do not wait for the scheduled pass, which rests at night). While ideas are still waiting and the day's AI budget
 * is not used up, the next call starts itself.
 */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  try {
    const result = await import("@/lib/scout/catchup").then(({ catchUp }) => catchUp(230_000));
    console.log(`catch-up now: ${result}`);
    const waiting = Number((await query(`SELECT count(*) AS n FROM catchup_queue WHERE status = 'pending'`))[0]?.n ?? 0);
    // Out of budget or another runner has it: stop here (the scheduled pass picks the rest up).
    // ...and so does a pass that got nothing done (an item that keeps failing must not start call after call).
    const more = waiting > 0 && /^[1-9]\d* caught up/.test(result) && !/budget|cap reached|another catch-up|switched off/i.test(result);
    if (more) await import("@/lib/scout/jobs").then(({ startJob }) => startJob(new URL(request.url).origin, "/api/cron/catchup", "lock:catchup:kick", 1)).catch(() => undefined);
    return NextResponse.json({ status: "ok", result, waiting, more });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`catch-up now failed: ${msg}`);
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}
