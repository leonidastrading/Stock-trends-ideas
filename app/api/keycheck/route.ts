import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { runKeyCheck } from "@/lib/scout/key-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** Settings → Test keys: one small real call per investigation key. Answers only works / failed and why, never a key. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { line, run } = await runKeyCheck();
    console.log(line);
    return NextResponse.json({ ok: true, ...run });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
