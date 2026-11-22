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
      case "listings": result = await import("@/lib/scout/listing-wait").then(({ runListingWatch }) => runListingWatch(deps.data ?? null, deps.now)); break;
      case "petitions": result = await import("@/lib/scout/petitions").then(({ runPetitionWatch }) => runPetitionWatch(deps.env, deps.now)); break;
    }
    console.log(result!);
    return NextResponse.json({ status: "ok", result: result! });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`job ${name} failed: ${msg}`);
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}
