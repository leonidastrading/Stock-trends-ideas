import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { badgeCounts, BADGE_TABS, type BadgeTab } from "@/lib/scout/badges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which deployment answered: the menu reloads the page when the site has been updated since it was opened. */
const BUILD = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev";

/** The menu's "new" badges: ?s={"ideas":"<iso>",…} (when each tab was last seen) → counts of newer items. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: true, counts: {}, build: BUILD });
  let since: Partial<Record<BadgeTab, string>> = {};
  try {
    const raw = JSON.parse(new URL(request.url).searchParams.get("s") ?? "{}") as Record<string, unknown>;
    since = Object.fromEntries(BADGE_TABS.filter((t) => typeof raw[t] === "string").map((t) => [t, raw[t] as string]));
  } catch {
    return NextResponse.json({ ok: false, errors: ["bad s"] }, { status: 422 });
  }
  return NextResponse.json({ ok: true, counts: await badgeCounts(since), build: BUILD }, { headers: { "cache-control": "no-store" } });
}
