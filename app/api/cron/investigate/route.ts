import { after, NextResponse } from "next/server";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { defaultDeps } from "@/lib/scout/engine";
import { getInvestigation, runInvestigation } from "@/lib/scout/investigate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Run one automatic investigation the scout started (called by the scout itself, with CRON_SECRET), in its own time limit. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    console.warn(`cron auth refused /api/cron/investigate: ${why.detail}`);
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  const id = Number(new URL(request.url).searchParams.get("id"));
  const inv = Number.isInteger(id) && id > 0 ? await getInvestigation(id) : null;
  if (!inv) return NextResponse.json({ error: "no such investigation" }, { status: 404 });
  if (inv.status !== "running" || inv.plan) return NextResponse.json({ status: "already started" });
  after(() => runInvestigation(id, defaultDeps()).catch((err) => console.error(`auto investigation ${id} failed: ${err instanceof Error ? err.message : String(err)}`)));
  return NextResponse.json({ status: "started", id }, { status: 202 });
}
