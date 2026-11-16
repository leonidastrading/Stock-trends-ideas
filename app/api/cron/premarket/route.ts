import { after, NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { marketDataFromEnv } from "@/lib/alpaca";
import { callResearchModel } from "@/lib/scout/llm";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The pre-market pass: every open card's invalidation, on overnight and pre-market news, before the paper trades enter. */
async function premarket() {
  const run = await store.startRun("premarket");
  const started = Date.now();
  try {
    const { checkInvalidations } = await import("@/lib/scout/invalidation");
    const invalidation = await checkInvalidations({ data: marketDataFromEnv(), callModel: callResearchModel, now: new Date(), env: process.env }, started + 270_000, { everyHours: 0, perCall: 60 });
    await store.finishRun(run, "ok", { invalidation });
    return { status: "ok" as const, invalidation };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, msg);
    return { status: "error" as const, error: msg };
  }
}

/**
 * Meant for an outside scheduler at 9:29 AM ET on weekdays (cron-job.org; Vercel's own cron on the Hobby plan is daily
 * and can fire anywhere within its hour). Bearer CRON_SECRET. Replies 202 at once and runs after the response;
 * ?wait=1 runs in the foreground and returns the result.
 */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (new URL(request.url).searchParams.get("wait") === "1") return NextResponse.json(await premarket());
  after(async () => { await premarket().catch((err) => console.error(`premarket run failed: ${err instanceof Error ? err.message : String(err)}`)); });
  return NextResponse.json({ status: "started", note: "checking every open card's invalidation; the result lands in Settings → Recent runs" }, { status: 202 });
}
