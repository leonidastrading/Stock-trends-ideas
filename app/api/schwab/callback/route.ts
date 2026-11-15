import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { connect, schwabConfig } from "@/lib/sources/schwab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Schwab sends you back after signing in (SCHWAB_CALLBACK_URL). Not behind the dashboard login, because the
 * redirect from Schwab may not carry it; instead it only accepts the one-time state set by /api/schwab/login.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (msg: string) => {
    const res = NextResponse.redirect(new URL(`/settings?schwab=${encodeURIComponent(msg)}#schwab`, request.url));
    res.cookies.set("schwab_state", "", { path: "/api/schwab", maxAge: 0 });
    return res;
  };
  const cfg = schwabConfig();
  if (!cfg || !hasDatabase()) return back("missing-settings");
  const state = url.searchParams.get("state");
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)schwab_state=([^;]+)/)?.[1];
  if (!state || !cookie || state !== cookie) return back("start-again");
  const code = url.searchParams.get("code");
  if (!code) return back(url.searchParams.get("error") ?? "no-code");
  try {
    await connect(cfg, code);
    return back("connected");
  } catch (err) {
    return back(err instanceof Error ? err.message.slice(0, 80) : "failed");
  }
}
