/** Basic-auth and cron-secret checks. Works in the proxy and in route handlers. Fails closed if unset. */

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function checkBasicAuth(header: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const user = env.DASHBOARD_USER;
  const pass = env.DASHBOARD_PASSWORD;
  if (!user || !pass || !header?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

/** Vercel cron sends "Authorization: Bearer $CRON_SECRET". */
export function checkCronSecret(header: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const secret = cleanSecret(env.CRON_SECRET);
  const got = cleanSecret(header);
  return !!secret && !!got && safeEqual(got, secret);
}

/**
 * Tolerant of what gets pasted by hand into Vercel or a scheduler: stray spaces or line breaks, "bearer" in any case,
 * "Bearer" typed twice (the scheduler's field already had it), and quotes around the value.
 */
function cleanSecret(v: string | null | undefined): string {
  let s = (v ?? "").trim();
  for (let i = 0; i < 3; i++) s = s.replace(/^bearer[\s:]+/i, "").replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").trim();
  return s;
}

/**
 * Why a cron call was refused, without the secret: what the caller sent (its length, not its value) against what the
 * server expects. Safe to log and to return to the caller (the expected length stays in the log only).
 */
export function cronAuthProblem(header: string | null, env: Record<string, string | undefined> = process.env): { reason: string; detail: string } {
  const secret = cleanSecret(env.CRON_SECRET);
  const got = cleanSecret(header);
  if (!secret) return { reason: "CRON_SECRET is not set on the server", detail: "server has no CRON_SECRET" };
  if (header === null) return { reason: "no Authorization header reached the app", detail: "no Authorization header" };
  if (!got) return { reason: "the Authorization header is empty", detail: `header of ${header.length} chars, empty after Bearer` };
  const shape = `${/^bearer/i.test(header.trim()) ? "with" : "without"} Bearer, ${got.length} chars received, ${secret.length} expected, ${/[^\x21-\x7e]/.test(got) ? "has spaces or non-ASCII" : "plain ASCII"}`;
  return { reason: got.length === secret.length ? "the secret does not match (same length, different value)" : "the secret does not match (different length)", detail: shape };
}

/**
 * A remembered sign-in: phone browsers forget basic-auth between tabs, so after one successful sign-in the browser
 * gets a signed cookie (180 days). Its signature is keyed on the dashboard login, so changing the password signs
 * every device out. Web Crypto only (works in the proxy).
 */
export const SESSION_COOKIE = "ts_session";
export const SESSION_DAYS = 180;

async function sign(message: string, env: Record<string, string | undefined>): Promise<string | null> {
  const user = env.DASHBOARD_USER, pass = env.DASHBOARD_PASSWORD;
  if (!user || !pass) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`trend-scout-session:${user}:${pass}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh cookie value: "<expiry ms>.<signature>". */
export async function makeSession(env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<string | null> {
  const exp = String(now + SESSION_DAYS * 86400_000);
  const sig = await sign(exp, env);
  return sig ? `${exp}.${sig}` : null;
}

export async function checkSession(value: string | undefined | null, env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<boolean> {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !(Number(exp) > now)) return false;
  const want = await sign(exp, env);
  return !!want && safeEqual(sig, want);
}

/** The Authorization header the dashboard login would send (handed on to the app when the cookie is valid). */
export function basicHeader(env: Record<string, string | undefined> = process.env): string | null {
  return env.DASHBOARD_USER && env.DASHBOARD_PASSWORD ? `Basic ${btoa(`${env.DASHBOARD_USER}:${env.DASHBOARD_PASSWORD}`)}` : null;
}
