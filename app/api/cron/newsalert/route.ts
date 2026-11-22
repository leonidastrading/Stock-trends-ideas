import { NextResponse } from "next/server";
import { quietReply } from "@/lib/quiet-hours";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { marketDataFromEnv } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phone alerts for breaking news on your stocks: halts, SEC filings, press releases and event headlines on any stock
 * with a recent card or on the watch-list. Meant for cron-job.org every minute (bearer CRON_SECRET); cheap, no AI.
 */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    console.warn(`cron auth refused ${new URL(request.url).pathname}: ${why.detail}`);
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  // Quiet hours: nothing from 8 PM to 6 AM ET, hourly on weekends, so the database can sleep (lib/quiet-hours.ts).
  const resting = quietReply(request, "minute");
  if (resting) return NextResponse.json(resting);
  // The catch-up queue is worked by the stories job (every 5 minutes, 2.5-minute budget): a research call can outlast
  // this job's 60 seconds, which timed it out.
  try {
    const { runNewsAlerts } = await import("@/lib/scout/news-alerts");
    const data = marketDataFromEnv(), now = new Date();
    const result = await runNewsAlerts({ data, now });
    // The press-release desk rides on the same minute (logging only in its windows; no AI).
    const pr = await import("@/lib/scout/pr-desk").then(({ runPrDesk }) => runPrDesk({ data, now })).catch((e) => `pr desk failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    return NextResponse.json({ status: "ok", result, pr });
  } catch (err) {
    return NextResponse.json({ status: "error", error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
