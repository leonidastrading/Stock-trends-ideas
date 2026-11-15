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
    const t = { refresh: "R1", refreshIssuedAt: "2026-11-15T12:00:00Z", access: "A1", accessExpiresAt: "2026-11-15T12:30:00Z" };
    const blob = seal(cfg, t);
    expect(blob).not.toContain("R1");
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
    expect(JSON.stringify((await store.cacheGet("secret:schwab"))?.data)).not.toMatch(/"R1"|"A1"/);

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
