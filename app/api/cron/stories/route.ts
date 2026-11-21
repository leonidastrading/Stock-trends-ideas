import { after, NextResponse } from "next/server";
import { quietReply } from "@/lib/quiet-hours";
import { background } from "@/lib/background";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
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
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    console.warn(`cron auth refused ${new URL(request.url).pathname}: ${why.detail}`);
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  // Quiet hours: nothing from 8 PM to 6 AM ET, hourly on weekends, so the database can sleep (lib/quiet-hours.ts).
  const resting = quietReply(request, "minutes");
  if (resting) return NextResponse.json(resting);
  const params = new URL(request.url).searchParams;
  // Anything the daily AI budget turned away is worked through once it resets (a no-op when nothing waits).
  background(async () => {
    // Right after a deploy: do the investigation keys work? (logged and shown on Settings; never the keys themselves)
    await import("@/lib/scout/key-check").then(({ checkKeysOnce }) => checkKeysOnce()).then((line) => line && console.log(line)).catch((err) => console.error(`key check failed: ${err instanceof Error ? err.message : String(err)}`));
    // Korea's company list (for DART filings) downloads slowly, so it is fetched in its own call when missing or a week old.
    await (async () => {
      if (!process.env.DART_API_KEY?.trim()) return;
      const { dartCorpsStale } = await import("@/lib/sources/asia-filings");
      if (!(await dartCorpsStale()) || !(await store.tryLock("lock:dartcorps", 6))) return;
      const { startJob } = await import("@/lib/scout/jobs");
      if (await startJob(new URL(request.url).origin, "/api/cron/dartcorps", "lock:dartcorps:start", 1)) console.log("dart corps: download started");
    })().catch((err) => console.error(`dart corps start failed: ${err instanceof Error ? err.message : String(err)}`));
    // Filing changes, crowding for open cards and the supply-chain read-through, each in its own time limit.
    await (async () => {
      const { JOBS, startJob } = await import("@/lib/scout/jobs");
      for (const [name, j] of Object.entries(JOBS)) await startJob(new URL(request.url).origin, `/api/cron/job/${name}`, `lock:job:${name}`, j.everyMin);
    })().catch((err) => console.error(`jobs start failed: ${err instanceof Error ? err.message : String(err)}`));
    // Reddit first (new posts, a little backfill), then once a day yesterday's rumor subreddits, then the catch-up queue.
    const { ingestReddit, readRedditRumors } = await import("@/lib/sources/arctic");
    await ingestReddit(Date.now() + 40_000).then((r) => console.log(`reddit ingest: ${r}`)).catch((err) => console.error(`reddit ingest failed: ${err instanceof Error ? err.message : String(err)}`));
    const { defaultDeps } = await import("@/lib/scout/engine");
    const { addDays, toEt } = await import("@/lib/time");
    const et = toEt(new Date());
    if (et.minutes >= 60) await readRedditRumors({ ...defaultDeps(), data: defaultDeps().data ?? null }, addDays(et.date, -1)).catch((err) => console.error(`reddit rumors failed: ${err instanceof Error ? err.message : String(err)}`));
    // A fresh story on a card stock about regulators, China or export controls, a short report or related parties: investigate (2 a day).
    await import("@/lib/scout/auto-investigate").then(({ maybeAutoInvestigate }) => maybeAutoInvestigate(new Date(), new URL(request.url).origin)).then((r) => console.log(r)).catch((err) => console.error(`auto-investigate failed: ${err instanceof Error ? err.message : String(err)}`));
    await import("@/lib/scout/catchup").then(({ catchUp }) => catchUp(150_000));
  });
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
