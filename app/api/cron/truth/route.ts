import { after, NextResponse } from "next/server";
import { quietReply } from "@/lib/quiet-hours";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Trump's posts: call every few minutes (Authorization: Bearer CRON_SECRET). Replies at once; reading, judging,
 * alerts and research run after the reply, one run at a time.
 */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    console.warn(`cron auth refused ${new URL(request.url).pathname}: ${why.detail}`);
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  // Quiet hours: nothing from 8 PM to 6 AM ET, hourly on weekends, so the database can sleep (lib/quiet-hours.ts).
  const resting = quietReply(request, "minutes");
  if (resting) return NextResponse.json(resting);
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  after(async () => {
    const store = await import("@/lib/scout/store");
    if (!(await store.tryLock("lock:truth", 5))) return;
    try {
      const [{ pollTruth }, { defaultDeps }] = await Promise.all([import("@/lib/scout/truth"), import("@/lib/scout/engine")]);
      const r = await pollTruth(defaultDeps());
      console.log(`truth: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error(`truth failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await store.unlock("lock:truth").catch(() => undefined);
    }
  });
  return NextResponse.json({ ok: true, checking: true }, { status: 202 });
}
