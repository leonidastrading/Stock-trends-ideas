import { NextResponse, type NextRequest } from "next/server";
import { isCardApiRequest } from "@/lib/scout/card-api-path";
import { basicHeader, checkBasicAuth, checkSession, makeSession, SESSION_COOKIE, SESSION_DAYS } from "@/lib/auth";

/**
 * Basic auth on everything except the cron endpoints (own secret), /api/health and the read-only card API (GET
 * /api/cards/<id>, own bearer token). After one successful sign-in the
 * browser gets a signed cookie, so new tabs and phone browsers do not ask again; with a valid cookie the request is
 * passed on with the login header added, so every route's own check keeps working.
 */
export async function proxy(request: NextRequest) {
  // The read-only card API (GET /api/cards/<id>) takes only its own bearer token, never the site login.
  if (isCardApiRequest(request.nextUrl.pathname, request.method)) return NextResponse.next();
  if (checkBasicAuth(request.headers.get("authorization"))) {
    const res = NextResponse.next();
    if (!(await checkSession(request.cookies.get(SESSION_COOKIE)?.value))) {
      const value = await makeSession();
      if (value) res.cookies.set(SESSION_COOKIE, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    }
    return res;
  }
  if (await checkSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    const header = basicHeader();
    if (header) {
      const headers = new Headers(request.headers);
      headers.set("authorization", header);
      return NextResponse.next({ request: { headers } });
    }
  }
  return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="trend-scout", charset="UTF-8"' } });
}

export const config = {
  matcher: ["/((?!api/cron|api/health|api/schwab/callback|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)"],
};
