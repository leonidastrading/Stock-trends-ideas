import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { authorizeUrl, schwabConfig } from "@/lib/sources/schwab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settings → Connect Schwab: off to Schwab's sign-in page, with a one-time state to check on the way back. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = schwabConfig();
  if (!cfg) return NextResponse.redirect(new URL("/settings?schwab=missing-settings#schwab", request.url));
  const state = randomBytes(18).toString("base64url");
  const res = NextResponse.redirect(authorizeUrl(cfg, state));
  res.cookies.set("schwab_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/schwab", maxAge: 900 });
  return res;
}
