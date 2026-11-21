import { NextResponse } from "next/server";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";
import { refreshDartCorps } from "@/lib/sources/asia-filings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
// Run next to DART (Seoul): from the US the company-list download did not finish in 4.5 minutes.
export const preferredRegion = "icn1";

/** Download DART's company list in its own time limit (it is slow from Vercel), started by the stories job when the saved list is missing or a week old. */
export async function GET(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) {
    const why = cronAuthProblem(request.headers.get("authorization"));
    return NextResponse.json({ error: "unauthorized", reason: why.reason }, { status: 401 });
  }
  try {
    const r = await refreshDartCorps(process.env);
    console.log(`dart corps: ${r}`);
    return NextResponse.json({ status: "ok", result: r });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`dart corps failed: ${msg}`);
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}
