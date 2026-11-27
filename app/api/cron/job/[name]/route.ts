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
      case "upgrades": result = await import("@/lib/scout/upgrades").then(({ runUpgrades }) => runUpgrades(deps.data ?? null, deps.now)); break;
      case "driftlist": result = deps.data ? `drift list book: ${await import("@/lib/scout/drift-list").then(({ updateListBook }) => updateListBook(deps.data!, deps.now))}` : "drift list book: waiting for market data (Alpaca keys)"; break;
      case "prdesk": result = await import("@/lib/scout/pr-desk").then(({ runPrDesk }) => runPrDesk({ data: deps.data ?? null, now: deps.now })); break;
      case "filingcheck": result = await import("@/lib/scout/primary").then(async ({ filingCheck }) => filingCheck({ data: deps.data ?? null, env: deps.env, now: deps.now }, async () => (await import("@/lib/scout/stories")).runStories({ ...deps, startBy: Date.now() + 150_000 }, 2, { primaryOnly: true }))); break;
      case "longterm": result = await import("@/lib/scout/long-term").then(({ runLongTerm }) => runLongTerm(deps.env)); break;
      case "watchlist": result = await import("@/lib/scout/store").then(({ watchlistUpkeep }) => watchlistUpkeep()).then((r) => `watch-list: ${r.before.active} active and ${r.before.proposed} proposed before, ${r.after.active} active and ${r.after.proposed} proposed after; ${r.retired} retired${r.retired ? ` (${Object.entries(r.why).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`); break;
      case "earningsrepair": result = deps.data ? `earnings repair: ${await import("@/lib/scout/earnings").then(({ repairLateScans }) => repairLateScans(deps.data!, deps.now, 60))}` : "earnings repair: waiting for market data (Alpaca keys)"; break;
      case "pricecheck": result = deps.data ? await import("@/lib/scout/tracking").then(({ runPriceCheck }) => runPriceCheck(deps.data!, deps.now)) : "price check: waiting for market data (Alpaca keys)"; break;
      case "preearnings": result = await import("@/lib/scout/pre-earnings").then(({ runPreEarnings }) => runPreEarnings(deps)); break;
      case "ratingstudy": {
        const r = await import("@/lib/scout/rating-study").then(({ runRatingStudy }) => runRatingStudy(deps.data ?? null));
        result = r.line;
        // Not finished: the next pass starts at once, in its own 5 minutes (day or night), until the history is read.
        if (r.more) await import("@/lib/scout/jobs").then(({ startJob }) => startJob(new URL(request.url).origin, "/api/cron/job/ratingstudy", "lock:job:ratingstudy:next", 1)).catch(() => undefined);
        break;
      }
    }
    // Each job's state goes on the health panel (Settings) and on Home when it is not reporting.
    await import("@/lib/scout/health").then(({ reportHealth, saysFailed }) => reportHealth(`job:${name}`, !saysFailed(result!), result!)).catch(() => undefined);
    // The finished study answers every 5 minutes: not worth a log line each time.
    if (!/^(rating|panel) study: (done|waiting)|^earnings repair: no rows|^pr desk: (0 logged, 0 outcomes|another pass)|^long term: all |^filing check: nothing new/.test(result!)) console.log(result!);
    return NextResponse.json({ status: "ok", result: result! });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`job ${name} failed: ${msg}`);
    await import("@/lib/scout/health").then(({ reportHealth }) => reportHealth(`job:${name}`, false, msg)).catch(() => undefined);
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}
