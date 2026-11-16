import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { breakingNews, newsFeed } from "@/lib/scout/newsfeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The News tab's live feed (polled every 30 seconds by the page). */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // ?breaking=1: the running ticker's short list (every page polls it).
    if (new URL(request.url).searchParams.get("breaking") === "1") return NextResponse.json({ ok: true, at: new Date().toISOString(), items: breakingNews(await newsFeed(), new Date()) }, { headers: { "cache-control": "no-store" } });
    return NextResponse.json({ ok: true, at: new Date().toISOString(), items: await newsFeed() }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
