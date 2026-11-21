import { after, NextResponse } from "next/server";
import { quietReply } from "@/lib/quiet-hours";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { chatterBatch } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Chatter test: measure the next batch of the 198 symbols not yet measured
 * today (weekdays). The hourly story call already does this; this route is for
 * a separate scheduler entry if the story scans run long. Replies 202 at once;
 * ?wait=1 runs in the foreground.
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
  if (new URL(request.url).searchParams.get("wait") === "1") return NextResponse.json(await chatterBatch());
  after(async () => {
    const r = await chatterBatch();
    if (typeof r === "string") console.error(`chatter batch ${r}`);
  });
  return NextResponse.json({ status: "started" }, { status: 202 });
}
