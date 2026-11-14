import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { handleImport } from "@/lib/scout/import-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Same as /api/import, for automation: Authorization: Bearer CRON_SECRET. */
export async function POST(request: Request) {
  if (!checkCronSecret(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return handleImport(request);
}
