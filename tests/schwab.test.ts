import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { accessToken, assertMarketDataOnly, authorizeUrl, connect, readShortInterest, schwabStatus, seal, shortInterest, squeezeRisk, unseal } from "@/lib/sources/schwab";
import * as store from "@/lib/scout/store";

const env = { SCHWAB_APP_KEY: "app-key", SCHWAB_APP_SECRET: "app-secret", SCHWAB_CALLBACK_URL: "https://scout.example/api/schwab/callback" } as unknown as NodeJS.ProcessEnv;
const cfg = { key: "app-key", secret: "app-secret", callback: "https://scout.example/api/schwab/callback" };

describe("Schwab: read-only market data", () => {
  it("allows market-data reads only; the trader API (accounts, orders) is refused", () => {
    expect(() => assertMarketDataOnly("https://api.schwabapi.com/marketdata/v1/instruments?symbol=GME&projection=fundamental")).not.toThrow();
    expect(() => assertMarketDataOnly("https://api.schwabapi.com/marketdata/v1/quotes?symbols=GME")).not.toThrow();
    for (const bad of ["https://api.schwabapi.com/trader/v1/accounts", "https://api.schwabapi.com/trader/v1/accounts/123/orders", "https://api.schwabapi.com/marketdata/v1/../../trader/v1/orders", "https://evil.example/marketdata/v1/quotes"]) {
      expect(() => assertMarketDataOnly(bad)).toThrow(/read-only|not allowed/);
    }
  });

  it("no code in the app calls Schwab's trader API", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    for (const d of ["lib", "app", "components"]) walk(join(process.cwd(), d));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/schwabapi\.com\/trader|\/trader\/v1/);
  });

  it("the sign-in link carries the app key, return address and state, never the secret", () => {
    const u = authorizeUrl(cfg, "st8");
    expect(u).toBe("https://api.schwabapi.com/v1/oauth/authorize?client_id=app-key&redirect_uri=https%3A%2F%2Fscout.example%2Fapi%2Fschwab%2Fcallback&response_type=code&state=st8");
    expect(u).not.toContain("app-secret");
  });

  it("tokens are stored encrypted; a different app secret cannot read them", () => {
    const t = { refresh: "refresh-token-plaintext-XYZ", refreshIssuedAt: "2026-11-15T12:00:00Z", access: "access-token-plaintext-XYZ", accessExpiresAt: "2026-11-15T12:30:00Z" };
    const blob = seal(cfg, t);
    expect(blob).not.toMatch(/plaintext|refresh-token|access-token/);
    expect(unseal(cfg, blob)).toEqual(t);
    expect(unseal({ ...cfg, secret: "other" }, blob)).toBeNull();
  });

  it("reads short interest whatever Schwab calls the fields, and rates squeeze risk", () => {
    const s = readShortInterest("GME", { symbol: "GME", peRatio: 50, shortIntToFloat: 21.4, shortIntDayToCover: 3.2, divYield: 0 });
    expect(s).toEqual({ symbol: "GME", pctFloat: 21.4, daysToCover: 3.2, fields: { shortIntToFloat: 21.4, shortIntDayToCover: 3.2 } });
    expect(squeezeRisk(s)).toBe("high");
    expect(squeezeRisk({ ...s, pctFloat: 12, daysToCover: 2 })).toBe("elevated");
    expect(squeezeRisk({ ...s, pctFloat: 3, daysToCover: 1 })).toBe("normal");
    expect(squeezeRisk(readShortInterest("X", { peRatio: 9 }))).toBeNull();
  });
});

describe("Schwab: weekly sign-in and token refresh (PGlite, fake Schwab)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    for (const [k, v] of Object.entries(env)) process.env[k] = v as string;
  });
  afterAll(() => {
    setQuerierForTests(null);
    for (const k of Object.keys(env)) delete process.env[k];
  });

  it("connects with the one-time code, refreshes the 30-minute token, and lapses after 7 days", async () => {
    const calls: Array<{ url: string; body?: string; auth?: string }> = [];
    let n = 0;
    const fake = (async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url, body: init?.body as string | undefined, auth: h.get("authorization") ?? undefined });
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: `A${++n}`, refresh_token: "R1", expires_in: 1800 });
      if (url.includes("/marketdata/v1/instruments")) return Response.json({ instruments: [{ symbol: "GME", fundamental: { shortIntToFloat: 21.4, shortIntDayToCover: 3.2 } }] });
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    const t0 = new Date("2026-11-15T12:00:00Z");
    expect(await schwabStatus(env, t0)).toEqual({ configured: true, connected: false, expiresAt: null, hoursLeft: null });
    await connect(cfg, "CODE@1", fake, t0);
    expect(calls[0].body).toBe("grant_type=authorization_code&code=CODE%401&redirect_uri=https%3A%2F%2Fscout.example%2Fapi%2Fschwab%2Fcallback");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("app-key:app-secret").toString("base64")}`);
    // Stored encrypted: the database never holds the tokens in clear.
    expect(JSON.stringify((await store.cacheGet("secret:schwab"))?.data)).not.toMatch(/"R1"|"A1"|grant|refresh/); // only an opaque blob

    expect(await accessToken(fake, env, new Date("2026-11-15T12:10:00Z"))).toBe("A1"); // still fresh
    expect(await accessToken(fake, env, new Date("2026-11-15T12:45:00Z"))).toBe("A2"); // refreshed
    expect(calls.at(-1)!.body).toBe("grant_type=refresh_token&refresh_token=R1");
    expect(await schwabStatus(env, new Date("2026-11-21T12:00:00Z"))).toMatchObject({ connected: true, hoursLeft: 24 });
    expect(await accessToken(fake, env, new Date("2026-11-22T12:01:00Z"))).toBeNull(); // weekly sign-in lapsed
    expect((await schwabStatus(env, new Date("2026-11-22T13:00:00Z"))).connected).toBe(false);
  });

  it("reads short interest through the market-data endpoint with the access token", async () => {
    const seen: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "A9", refresh_token: "R2", expires_in: 1800 });
      return Response.json({ instruments: [{ symbol: "GME", fundamental: { shortIntToFloat: 21.4, shortIntDayToCover: 3.2 } }] });
    }) as typeof fetch;
    await connect(cfg, "CODE2", fake, new Date());
    const si = await shortInterest(["GME"], fake);
    expect(si.get("GME")).toMatchObject({ pctFloat: 21.4, daysToCover: 3.2 });
    expect(seen.at(-1)).toBe("https://api.schwabapi.com/marketdata/v1/instruments?symbol=GME&projection=fundamental Bearer A9");
  });
});

describe("Schwab: sharing oo-trading's login (fake Upstash Redis)", () => {
  const shared = { KV_REST_API_URL: "https://redis.example", KV_REST_API_TOKEN: "kv-token", SCHWAB_CLIENT_ID: "oo-id", SCHWAB_CLIENT_SECRET: "oo-secret" } as unknown as NodeJS.ProcessEnv;
  const fakeRedis = (db: Map<string, string>, log: string[]) => (async (url: string, init?: RequestInit) => {
    if (url === "https://redis.example") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kv-token");
      const [cmd, key, ...rest] = JSON.parse(init!.body as string) as string[];
      log.push(`${cmd} ${key}`);
      if (cmd === "GET") return Response.json({ result: db.get(key) ?? null });
      if (cmd === "SET") { if (rest.includes("NX") && db.has(key)) return Response.json({ result: null }); db.set(key, String(rest[0])); return Response.json({ result: "OK" }); }
      if (cmd === "DEL") { db.delete(key); return Response.json({ result: 1 }); }
      if (cmd === "INCR") { const n = Number(db.get(key) ?? 0) + 1; db.set(key, String(n)); return Response.json({ result: n }); }
      if (cmd === "EXPIRE") return Response.json({ result: 1 });
    }
    if (url.endsWith("/oauth/token")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("oo-id:oo-secret").toString("base64")}`);
      log.push(`token ${init!.body}`);
      return Response.json({ access_token: "A-NEW", expires_in: 1800 });
    }
    if (url.includes("/marketdata/v1/instruments")) { log.push(`schwab ${new Headers(init?.headers).get("authorization")}`); return Response.json({ instruments: [{ symbol: "GME", fundamental: { shortIntToFloat: 21.4 } }] }); }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const now = Date.parse("2026-11-16T15:00:00Z");
  const tokens = (o: Partial<import("@/lib/sources/schwab").SharedTokens> = {}) => JSON.stringify({ accessToken: "A-OLD", refreshToken: "R-OO", accessExpiresAt: now + 20 * 60_000, refreshIssuedAt: now - 2 * 86400_000, updatedAt: now, ...o });

  it("uses oo-trading's access token while it is fresh, and reports its weekly deadline", async () => {
    const db = new Map([["schwab:tokens", tokens()]]), log: string[] = [];
    expect(await accessToken(fakeRedis(db, log), shared, new Date(now))).toBe("A-OLD");
    expect(log).toEqual(["GET schwab:tokens"]);
    expect(await schwabStatus(shared, new Date(now), fakeRedis(db, log))).toMatchObject({ mode: "shared", connected: true, hoursLeft: 120, canRefresh: true });
  });

  it("refreshes under oo-trading's lock and writes the token back in its format", async () => {
    const db = new Map([["schwab:tokens", tokens({ accessExpiresAt: now + 30_000 })]]), log: string[] = [];
    expect(await accessToken(fakeRedis(db, log), shared, new Date(now))).toBe("A-NEW");
    expect(log).toEqual(["GET schwab:tokens", "SET schwab:refresh-lock", "token grant_type=refresh_token&refresh_token=R-OO", "SET schwab:tokens", "DEL schwab:refresh-lock"]);
    const saved = JSON.parse(db.get("schwab:tokens")!);
    expect(saved).toMatchObject({ accessToken: "A-NEW", refreshToken: "R-OO", refreshIssuedAt: now - 2 * 86400_000 });
    expect(db.has("schwab:refresh-lock")).toBe(false);
  });

  it("counts requests in oo-trading's per-minute window and respects its back-off", async () => {
    // shortInterest reads the real clock, so the token's times are relative to it (not the fixed test date).
    const real = Date.now();
    const db = new Map([["schwab:tokens", tokens({ accessExpiresAt: real + 20 * 60_000, refreshIssuedAt: real - 2 * 86400_000, updatedAt: real })]]), log: string[] = [];
    process.env.KV_REST_API_URL = "https://redis.example"; process.env.KV_REST_API_TOKEN = "kv-token"; process.env.SCHWAB_CLIENT_ID = "oo-id"; process.env.SCHWAB_CLIENT_SECRET = "oo-secret";
    try {
      const si = await shortInterest(["GME"], fakeRedis(db, log));
      expect(si.get("GME")?.pctFloat).toBe(21.4);
      expect(log.filter((l) => l.startsWith("INCR schwab:rl:")).length).toBe(1);
      expect(log.at(-1)).toBe("schwab Bearer A-OLD");
      db.set("schwab:backoff", JSON.stringify({ n: 1, until: Date.now() + 60_000 }));
      await expect(shortInterest(["GME"], fakeRedis(db, log))).rejects.toThrow(/backing off/);
    } finally {
      for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET"]) delete process.env[k];
    }
  });

  it("a lapsed or flagged login is not used", async () => {
    const log: string[] = [];
    expect(await accessToken(fakeRedis(new Map([["schwab:tokens", tokens({ needsReconnect: true })]]), log), shared, new Date(now))).toBeNull();
    expect(await accessToken(fakeRedis(new Map([["schwab:tokens", tokens({ accessExpiresAt: now - 1, refreshIssuedAt: now - 8 * 86400_000 })]]), log), shared, new Date(now))).toBeNull();
  });
});
