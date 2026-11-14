import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { handleImport } from "@/lib/scout/import-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return handleImport(request);
}
