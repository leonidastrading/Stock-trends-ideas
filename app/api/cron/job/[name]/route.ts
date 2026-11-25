import { NextResponse } from "next/server";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { defaultDeps } from "@/lib/scout/engine";
import { JOBS, type JobName } from "@/lib/scout/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** One background job, in its own 5 minutes (started by the stories cron; see lib/scout/jobs.ts). */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  const { name } = await ctx.params;
  if (!(name in JOBS)) return NextResponse.json({ error: "no such job" }, { status: 404 });
  const deps = defaultDeps();
  try {
    let result: string;
    switch (name as JobName) {
      case "filingdiff": result = await import("@/lib/scout/filing-diff-run").then(({ runFilingDiffs }) => runFilingDiffs(deps)); break;
      case "crowding": result = await import("@/lib/scout/crowding").then(({ runCrowdingBatch }) => runCrowdingBatch(deps.data ?? null, deps.now, deps.env)); break;
      case "readthrough": result = await import("@/lib/scout/readthrough").then(({ runReadthrough }) => runReadthrough(deps)); break;
      case "bubbles": result = await import("@/lib/scout/bubbles").then(({ runBubbles }) => runBubbles(deps)); break;
      case "sitewatch": result = await import("@/lib/scout/site-watch").then(({ runSiteWatch }) => runSiteWatch(deps)); break;
      case "evidence": result = await import("@/lib/scout/evidence-archive").then(({ runEvidenceArchive }) => runEvidenceArchive()); break;
      case "topnews": result = await import("@/lib/scout/top-news").then(({ runTopNews }) => runTopNews(deps)); break;
      case "sttrending": result = await import("@/lib/scout/st-trending").then(({ runStTrending }) => runStTrending({ data: deps.data ?? null, now: deps.now })); break;
      case "listings": result = await import("@/lib/scout/listing-wait").then(({ runListingWatch }) => runListingWatch(deps.data ?? null, deps.now)); break;
      case "petitions": result = await import("@/lib/scout/petitions").then(({ runPetitionWatch }) => runPetitionWatch(deps.env, deps.now)); break;
      case "fdaletters": result = await import("@/lib/scout/fda-letters").then(({ runFdaLetters }) => runFdaLetters(deps.env, deps.now)); break;
      case "panelwatch": result = await import("@/lib/scout/panel-watch").then(({ runPanelWatch }) => runPanelWatch(deps.env, deps.now)); break;
      case "panelstudy": result = await import("@/lib/scout/panel-study").then(({ runPanelStudy }) => runPanelStudy(deps.data ?? null, deps.now)); break;
      case "preearnings": result = await import("@/lib/scout/pre-earnings").then(({ runPreEarnings }) => runPreEarnings(deps)); break;
      case "ratingstudy": {
        const r = await import("@/lib/scout/rating-study").then(({ runRatingStudy }) => runRatingStudy(deps.data ?? null));
        result = r.line;
        // Not finished: the next pass starts at once, in its own 5 minutes (day or night), until the history is read.
        if (r.more) await import("@/lib/scout/jobs").then(({ startJob }) => startJob(new URL(request.url).origin, "/api/cron/job/ratingstudy", "lock:job:ratingstudy:next", 1)).catch(() => undefined);
        break;
      }
    }
    // The finished study answers every 5 minutes: not worth a log line each time.
    if (!/^(rating|panel) study: (done|waiting)/.test(result!)) console.log(result!);
    return NextResponse.json({ status: "ok", result: result! });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`job ${name} failed: ${msg}`);
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}
