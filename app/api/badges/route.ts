import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { badgeCounts, BADGE_TABS, type BadgeTab } from "@/lib/scout/badges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The menu's "new" badges: ?s={"ideas":"<iso>",…} (when each tab was last seen) → counts of newer items. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: true, counts: {} });
  let since: Partial<Record<BadgeTab, string>> = {};
  try {
    const raw = JSON.parse(new URL(request.url).searchParams.get("s") ?? "{}") as Record<string, unknown>;
    since = Object.fromEntries(BADGE_TABS.filter((t) => typeof raw[t] === "string").map((t) => [t, raw[t] as string]));
  } catch {
    return NextResponse.json({ ok: false, errors: ["bad s"] }, { status: 422 });
  }
  return NextResponse.json({ ok: true, counts: await badgeCounts(since) }, { headers: { "cache-control": "no-store" } });
}
