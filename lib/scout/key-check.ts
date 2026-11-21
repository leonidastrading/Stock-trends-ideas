/**
 * Does each investigation key work? One small real call per key, once per deployment (so a key added in Vercel is
 * checked right after the redeploy), logged and kept for the Settings page. Only "works" / "failed: why" is kept:
 * never a key, never an address that carries one.
 */
import { query as q } from "../db";

export interface KeyCheck { key: string; status: "works" | "failed" | "not set"; detail: string }
export interface KeyCheckRun { at: string; deployment: string; checks: KeyCheck[] }

export const CHECKED_KEYS = ["BRAVE_SEARCH_API_KEY", "COURTLISTENER_TOKEN", "EDINET_API_KEY", "DART_API_KEY"] as const;

export async function checkKeys(env: NodeJS.ProcessEnv, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<KeyCheck[]> {
  const [{ webSearch }, { courtDockets }, { edinetFilings, dartFilings }] = await Promise.all([import("../sources/websearch"), import("../sources/world-records"), import("../sources/asia-filings")]);
  const one = async (key: (typeof CHECKED_KEYS)[number], run: () => Promise<string>): Promise<KeyCheck> => {
    if (!env[key]?.trim()) return { key, status: "not set", detail: "" };
    try {
      return { key, status: "works", detail: await run() };
    } catch (e) {
      const v = env[key]!.trim();
      // Belt and braces: never keep a message that somehow contains the key.
      return { key, status: "failed", detail: (e instanceof Error ? e.message : String(e)).split(v).join("…").slice(0, 200) };
    }
  };
  const throwIf = (r: { error?: string; rows: unknown[] }, what: string) => {
    if (r.error) throw new Error(r.error);
    return `${r.rows.length} ${what}`;
  };
  return Promise.all([
    one("BRAVE_SEARCH_API_KEY", async () => `${(await webSearch("Nvidia earnings", env, fetchImpl, 3)).length} search results`),
    one("COURTLISTENER_TOKEN", async () => throwIf(await courtDockets("Nvidia Corporation", env, fetchImpl), "dockets for Nvidia")),
    one("EDINET_API_KEY", async () => throwIf(await edinetFilings("7203", now, env, fetchImpl, 7), "Toyota filings in 7 days")),
    one("DART_API_KEY", async () => throwIf(await dartFilings("005930", now, env, fetchImpl), "Samsung Electronics filings in 180 days")),
  ]);
}

/** Once per deployment: check the keys, log the outcome, keep it for Settings. Returns the log line, or null if already done. */
export async function checkKeysOnce(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<string | null> {
  const store = await import("./store");
  const deployment = env.VERCEL_DEPLOYMENT_ID ?? "local";
  if (!(await store.tryLock(`keycheck:${deployment}`, 60 * 24 * 60))) return null;
  const checks = await checkKeys(env, now);
  const run: KeyCheckRun = { at: now.toISOString(), deployment, checks };
  await q(`INSERT INTO dashboard_cache (key, data, updated_at) VALUES ('keycheck:last', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(run)]);
  return `key check: ${checks.map((c) => `${c.key} ${c.status}${c.detail ? ` (${c.detail})` : ""}`).join(" · ")}`;
}

export async function lastKeyCheck(): Promise<KeyCheckRun | null> {
  const r = (await q(`SELECT data FROM dashboard_cache WHERE key = 'keycheck:last'`).catch(() => []))[0];
  return r ? (r.data as KeyCheckRun) : null;
}
