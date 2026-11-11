import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean(),
  model: z.string().trim().min(1).max(60),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  dailyCapUsd: z.number().min(0).max(1000),
  maxCandidatesPerScan: z.number().int().min(0).max(50),
  emailDigest: z.boolean(),
});

/** Changing the model or effort starts a new version; results are reported per version. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  await store.saveSettings(parsed.data);
  return NextResponse.json({ ok: true });
}
