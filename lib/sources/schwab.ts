/**
 * Schwab market data, read-only. Two ways to be signed in:
 * - Shared (preferred): the oo-trading app's Schwab login, read from its Upstash Redis (KV_REST_API_URL /
 *   KV_REST_API_TOKEN, key "schwab:tokens"). The scout follows that app's rules: the same refresh lock, the same
 *   per-minute request counter and back-off, and the same token format, so the two apps never fight. Signing in
 *   again happens in oo-trading. Refreshing the 30-minute token needs SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET (the
 *   same app's); without them the scout only uses the token while oo-trading keeps it fresh.
 * - Own: a Schwab app of the scout's own (SCHWAB_APP_KEY / SCHWAB_APP_SECRET / SCHWAB_CALLBACK_URL), signed in
 *   weekly from Settings, tokens kept here.
 *
 * Safety:
 * - Only GET requests to the market-data host's allowlist (quotes, instruments, chains, price history,
 *   movers, market hours). The trader API (accounts, positions, orders) is never called.
 * - Tokens are stored encrypted (AES-256-GCM, key derived from SCHWAB_APP_SECRET) and never logged,
 *   returned by any route or shown on any page. Errors carry Schwab's status and error code only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as store from "../scout/store";

export const SCHWAB_OAUTH = "https://api.schwabapi.com/v1/oauth";
export const SCHWAB_DATA = "https://api.schwabapi.com/marketdata/v1";
const ALLOWED: RegExp[] = [/^\/quotes$/, /^\/instruments$/, /^\/chains$/, /^\/pricehistory$/, /^\/movers\/[$A-Z.]{1,12}$/, /^\/markets$/];
const KEY = "secret:schwab";

/** Throws unless the URL is a market-data read on the allowlist. */
export function assertMarketDataOnly(url: string): void {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/marketdata\/v1/, "");
  if (u.origin !== new URL(SCHWAB_DATA).origin || !u.pathname.startsWith("/marketdata/v1/") || !ALLOWED.some((re) => re.test(path))) {
    throw new Error(`Schwab client is read-only market data: ${u.pathname} is not allowed`);
  }
}

export interface SchwabConfig { key: string; secret: string; callback: string }

export function schwabConfig(env: NodeJS.ProcessEnv = process.env): SchwabConfig | null {
  const key = env.SCHWAB_APP_KEY?.trim(), secret = env.SCHWAB_APP_SECRET?.trim(), callback = env.SCHWAB_CALLBACK_URL?.trim();
  return key && secret && callback ? { key, secret, callback } : null;
}

export const authorizeUrl = (cfg: SchwabConfig, state: string) =>
  `${SCHWAB_OAUTH}/authorize?${new URLSearchParams({ client_id: cfg.key, redirect_uri: cfg.callback, response_type: "code", state })}`;

// ------------------------------------------------------------ token storage (encrypted)

export interface Tokens { refresh: string; refreshIssuedAt: string; access: string; accessExpiresAt: string }

const cryptoKey = (cfg: SchwabConfig) => createHash("sha256").update(`trend-scout schwab tokens:${cfg.secret}`).digest();

/** Pure: encrypt / decrypt the token record (AES-256-GCM). */
export function seal(cfg: SchwabConfig, t: Tokens): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cryptoKey(cfg), iv);
  const body = Buffer.concat([c.update(JSON.stringify(t), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function unseal(cfg: SchwabConfig, blob: string): Tokens | null {
  try {
    const [iv, tag, body] = blob.split(".").map((x) => Buffer.from(x, "base64"));
    const d = createDecipheriv("aes-256-gcm", cryptoKey(cfg), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8")) as Tokens;
  } catch {
    return null; // wrong key (the app secret changed) or damaged: reconnect
  }
}

async function load(cfg: SchwabConfig): Promise<Tokens | null> {
  const c = await store.cacheGet<{ blob: string }>(KEY).catch(() => null);
  return c?.data?.blob ? unseal(cfg, c.data.blob) : null;
}
const save = (cfg: SchwabConfig, t: Tokens) => store.cachePut(KEY, { blob: seal(cfg, t) });

// ------------------------------------------------------------ shared login (oo-trading's Redis)

export interface SharedConfig { url: string; token: string; clientId: string | null; clientSecret: string | null }

export function sharedConfig(env: NodeJS.ProcessEnv = process.env): SharedConfig | null {
  const url = (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL)?.trim(), token = (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token, clientId: env.SCHWAB_CLIENT_ID?.trim() || null, clientSecret: env.SCHWAB_CLIENT_SECRET?.trim() || null };
}

/** oo-trading's keys (src/lib/kv.ts KEYS). Only these are ever read or written. */
export const SHARED_KEYS = { tokens: "schwab:tokens", refreshLock: "schwab:refresh-lock", backoff: "schwab:backoff", rate: (minute: number) => `schwab:rl:${minute}` };

/** oo-trading's token record (src/lib/schwab/tokens.ts SchwabTokens; times in ms). */
export interface SharedTokens { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshIssuedAt: number; updatedAt: number; needsReconnect?: boolean; lastError?: string }

async function redis<T = unknown>(cfg: SharedConfig, command: Array<string | number>, fetchImpl: typeof fetch): Promise<T> {
  if (!Object.values(SHARED_KEYS).some((k) => typeof k === "string" ? k === command[1] : String(command[1]).startsWith("schwab:rl:"))) throw new Error(`refusing Redis key ${String(command[1])}`);
  const res = await fetchImpl(cfg.url, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(command) });
  const j = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || j.error) throw new Error(`shared Schwab store ${res.status}${j.error ? `: ${j.error.slice(0, 80)}` : ""}`);
  return j.result as T;
}

/** Values are JSON, as @upstash/redis writes them. */
const parseValue = <T>(v: unknown): T | null => (v === null || v === undefined ? null : typeof v === "string" ? (() => { try { return JSON.parse(v) as T; } catch { return v as unknown as T; } })() : (v as T));

async function sharedTokens(cfg: SharedConfig, fetchImpl: typeof fetch): Promise<SharedTokens | null> {
  return parseValue<SharedTokens>(await redis(cfg, ["GET", SHARED_KEYS.tokens], fetchImpl));
}

const SHARED_REFRESH_EARLY_MS = 120_000;

/** oo-trading's access token, refreshed under its lock when close to expiry (if this app has the client id and secret). */
async function sharedAccessToken(cfg: SharedConfig, fetchImpl: typeof fetch, now = Date.now()): Promise<string | null> {
  let t = await sharedTokens(cfg, fetchImpl);
  if (!t || t.needsReconnect) return null;
  if (t.accessExpiresAt - now > SHARED_REFRESH_EARLY_MS) return t.accessToken;
  if (now > t.refreshIssuedAt + REFRESH_DAYS * 86400_000) return null;
  if (!cfg.clientId || !cfg.clientSecret) return t.accessExpiresAt > now + 5_000 ? t.accessToken : null;
  const got = await redis<string | null>(cfg, ["SET", SHARED_KEYS.refreshLock, "1", "PX", 10_000, "NX"], fetchImpl);
  if (got !== "OK") {
    // oo-trading (or another scout call) is refreshing: wait for it, as oo-trading does.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      t = await sharedTokens(cfg, fetchImpl);
      if (t && !t.needsReconnect && t.accessExpiresAt - Date.now() > SHARED_REFRESH_EARLY_MS) return t.accessToken;
    }
    return t && t.accessExpiresAt > Date.now() ? t.accessToken : null;
  }
  try {
    const j = await tokenCall({ key: cfg.clientId, secret: cfg.clientSecret, callback: "" }, { grant_type: "refresh_token", refresh_token: t.refreshToken }, fetchImpl);
    const at = Date.now();
    const next: SharedTokens = { ...t, accessToken: j.access_token, refreshToken: j.refresh_token ?? t.refreshToken, accessExpiresAt: at + (j.expires_in ?? 1800) * 1000, updatedAt: at, lastError: undefined };
    await redis(cfg, ["SET", SHARED_KEYS.tokens, JSON.stringify(next)], fetchImpl);
    return next.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const dead = /sign-in 40[01]/.test(msg);
    await redis(cfg, ["SET", SHARED_KEYS.tokens, JSON.stringify({ ...t, needsReconnect: dead || t.needsReconnect, lastError: msg })], fetchImpl);
    return null;
  } finally {
    await redis(cfg, ["DEL", SHARED_KEYS.refreshLock], fetchImpl).catch(() => undefined);
  }
}

/** Respect oo-trading's back-off and count this request in its per-minute window (Schwab allows ~120 a minute per app). */
async function sharedBudget(cfg: SharedConfig, fetchImpl: typeof fetch, now = Date.now()): Promise<void> {
  const b = parseValue<{ until?: number }>(await redis(cfg, ["GET", SHARED_KEYS.backoff], fetchImpl));
  if (b?.until && b.until > now) throw new Error(`Schwab is backing off for ${Math.ceil((b.until - now) / 1000)}s (shared with oo-trading)`);
  const minute = Math.floor(now / 60_000);
  const n = await redis<number>(cfg, ["INCR", SHARED_KEYS.rate(minute)], fetchImpl);
  await redis(cfg, ["EXPIRE", SHARED_KEYS.rate(minute), 70], fetchImpl);
  if (n > 100) throw new Error("Schwab request budget for this minute is used (shared with oo-trading)");
}

// ------------------------------------------------------------ OAuth

const REFRESH_DAYS = 7;

async function tokenCall(cfg: SchwabConfig, body: Record<string, string>, fetchImpl: typeof fetch): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetchImpl(`${SCHWAB_OAUTH}/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${cfg.key}:${cfg.secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== "string") throw new Error(`Schwab sign-in ${res.status}${typeof j.error === "string" ? `: ${j.error}` : ""}`);
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** The sign-in callback: trade the one-time code for tokens and store them. */
export async function connect(cfg: SchwabConfig, code: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<void> {
  const j = await tokenCall(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.callback }, fetchImpl);
  if (!j.refresh_token) throw new Error("Schwab sign-in returned no refresh token");
  await save(cfg, { refresh: j.refresh_token, refreshIssuedAt: now.toISOString(), access: j.access_token, accessExpiresAt: new Date(now.getTime() + (j.expires_in ?? 1800) * 1000).toISOString() });
}

export async function disconnect(): Promise<void> {
  await store.unlock(KEY);
}

export interface SchwabStatus { configured: boolean; connected: boolean; expiresAt: string | null; hoursLeft: number | null; mode?: "shared" | "own"; canRefresh?: boolean; lastError?: string | null }

export async function schwabStatus(env: NodeJS.ProcessEnv = process.env, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<SchwabStatus> {
  const shared = sharedConfig(env);
  if (shared) {
    const t = await sharedTokens(shared, fetchImpl);
    if (!t) return { configured: true, connected: false, expiresAt: null, hoursLeft: null, mode: "shared", canRefresh: !!shared.clientId };
    const expiresAt = new Date(t.refreshIssuedAt + REFRESH_DAYS * 86400_000);
    const hoursLeft = Math.round((expiresAt.getTime() - now.getTime()) / 3600_000);
    return { configured: true, connected: hoursLeft > 0 && !t.needsReconnect, expiresAt: expiresAt.toISOString(), hoursLeft, mode: "shared", canRefresh: !!(shared.clientId && shared.clientSecret), lastError: t.lastError ?? null };
  }
  const cfg = schwabConfig(env);
  if (!cfg) return { configured: false, connected: false, expiresAt: null, hoursLeft: null };
  const t = await load(cfg);
  if (!t) return { configured: true, connected: false, expiresAt: null, hoursLeft: null };
  const expiresAt = new Date(Date.parse(t.refreshIssuedAt) + REFRESH_DAYS * 86400_000);
  const hoursLeft = Math.round((expiresAt.getTime() - now.getTime()) / 3600_000);
  return { configured: true, connected: hoursLeft > 0, expiresAt: expiresAt.toISOString(), hoursLeft, mode: "own" };
}

/** A valid access token, refreshed when it has under a minute left. Null when not connected or the weekly sign-in has lapsed. */
export async function accessToken(fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<string | null> {
  const shared = sharedConfig(env);
  if (shared) return sharedAccessToken(shared, fetchImpl, now.getTime());
  const cfg = schwabConfig(env);
  if (!cfg) return null;
  const t = await load(cfg);
  if (!t) return null;
  if (now.getTime() - Date.parse(t.refreshIssuedAt) > REFRESH_DAYS * 86400_000) return null;
  if (Date.parse(t.accessExpiresAt) - now.getTime() > 60_000) return t.access;
  const j = await tokenCall(cfg, { grant_type: "refresh_token", refresh_token: t.refresh }, fetchImpl);
  const next: Tokens = { ...t, refresh: j.refresh_token ?? t.refresh, access: j.access_token, accessExpiresAt: new Date(now.getTime() + (j.expires_in ?? 1800) * 1000).toISOString() };
  await save(cfg, next);
  return next.access;
}

/** A market-data GET (allowlisted paths only). */
export async function schwabGet<T>(path: string, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const url = `${SCHWAB_DATA}${path}?${new URLSearchParams(params)}`;
  assertMarketDataOnly(url);
  const shared = sharedConfig();
  const token = await accessToken(fetchImpl);
  if (!token) throw new Error(shared ? "Schwab not connected: sign in again in oo-trading" : "Schwab not connected (Settings → Connect Schwab)");
  if (shared) await sharedBudget(shared, fetchImpl);
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`Schwab ${path} ${res.status}`);
  return (await res.json()) as T;
}

// ------------------------------------------------------------ short interest

export interface ShortInterest { symbol: string; pctFloat: number | null; daysToCover: number | null; fields: Record<string, number> }

/** Pure: short-interest numbers from Schwab's fundamental record, whatever the exact field names (anything with "short" in it is kept). */
export function readShortInterest(symbol: string, fundamental: Record<string, unknown> | undefined): ShortInterest {
  const fields: Record<string, number> = {};
  for (const [k, v] of Object.entries(fundamental ?? {})) if (/short/i.test(k) && typeof v === "number" && Number.isFinite(v)) fields[k] = v;
  const pick = (re: RegExp) => Object.entries(fields).find(([k]) => re.test(k))?.[1] ?? null;
  return { symbol, pctFloat: pick(/short.*(float|pct|percent)/i), daysToCover: pick(/(day|days).*cover|cover/i), fields };
}

/** Short interest for up to ~50 symbols per call, from the instruments endpoint's fundamental projection. */
export async function shortInterest(symbols: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, ShortInterest>> {
  const out = new Map<string, ShortInterest>();
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    const r = await schwabGet<{ instruments?: Array<{ symbol: string; fundamental?: Record<string, unknown> }> }>("/instruments", { symbol: chunk.join(","), projection: "fundamental" }, fetchImpl);
    for (const ins of r.instruments ?? []) out.set(ins.symbol, readShortInterest(ins.symbol, ins.fundamental));
  }
  return out;
}

/** Pure: squeeze risk from short interest (common rules of thumb: a fifth of the float short, or five-plus days to cover). */
export function squeezeRisk(s: ShortInterest | undefined): "high" | "elevated" | "normal" | null {
  if (!s || (s.pctFloat === null && s.daysToCover === null)) return null;
  const p = s.pctFloat ?? 0, d = s.daysToCover ?? 0;
  return p >= 20 || d >= 8 ? "high" : p >= 10 || d >= 5 ? "elevated" : "normal";
}
