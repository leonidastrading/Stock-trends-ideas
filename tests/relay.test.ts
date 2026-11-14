import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgar, route } from "@/lib/sources/edgar";
// @ts-expect-error plain JavaScript module
import { allowed, createRelay } from "../relay/server.mjs";

const upstream: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  if (h.get("user-agent") !== "Test Person test@example.com") return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
  return new Response(JSON.stringify({ hits: { total: { value: String(input).includes("startdt=2026-10") ? 11 : 36 }, hits: [{ _id: "x", _source: { display_names: ["ACME CORP"], form_type: "8-K", file_date: "2026-11-01" } }] } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let server: ReturnType<typeof createRelay>;
let base = "";
beforeAll(async () => {
  server = createRelay({ token: "t0k", userAgent: "Test Person test@example.com", fetchImpl: upstream, minIntervalMs: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("edgar relay", () => {
  it("allows only https on the listed hosts", () => {
    expect(allowed("https://efts.sec.gov/LATEST/search-index?q=x")).toBe(true);
    expect(allowed("http://efts.sec.gov/x")).toBe(false);
    expect(allowed("https://evil.example/x")).toBe(false);
    expect(allowed("nonsense")).toBe(false);
  });
  it("needs the token, refuses other hosts, forwards with the SEC user agent", async () => {
    const target = encodeURIComponent("https://efts.sec.gov/LATEST/search-index?q=%22x%22&startdt=2026-10-01");
    expect((await fetch(`${base}/fetch?url=${target}`)).status).toBe(401);
    expect((await fetch(`${base}/fetch?url=${encodeURIComponent("https://evil.example/")}`, { headers: { authorization: "Bearer t0k" } })).status).toBe(400);
    const ok = await fetch(`${base}/fetch?url=${target}`, { headers: { authorization: "Bearer t0k" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { hits: { total: { value: number } } }).hits.total.value).toBe(11);
    expect(((await (await fetch(`${base}/health`)).json()) as { hosts: string[] }).hosts).toEqual(["efts.sec.gov"]);
  });
  it("the scout's EDGAR source goes through the relay when configured", async () => {
    expect(route({} as NodeJS.ProcessEnv)).toBeNull();
    expect(route({ SEC_USER_AGENT: "a b" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    const env = { EDGAR_PROXY_URL: `${base}/`, EDGAR_PROXY_TOKEN: "t0k" } as unknown as NodeJS.ProcessEnv;
    expect(route(env)).not.toBeNull();
    const r = await edgar.probe({ term: "transformer shortage", kind: null, tickers: [], now: new Date("2026-11-12T12:00:00Z"), env });
    expect(r.status).toBe("ok");
    expect(r.signals[0]).toMatchObject({ metric: "filings_30d", value: 11, baseline: 3 });
    const bad = await edgar.probe({ term: "x", kind: null, tickers: [], now: new Date(), env: { ...env, EDGAR_PROXY_TOKEN: "wrong" } as unknown as NodeJS.ProcessEnv });
    expect(bad.signals).toEqual([]);
    expect(bad.status).toBe("missing"); // relay refused and no SEC_USER_AGENT for the JSON APIs
  });
});

describe("swing log 401 diagnosis", () => {
  it("tells Vercel's protection page from the app's own login", async () => {
    const { explain401 } = await import("@/lib/scout/swing");
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
    expect(explain401({ status: 401, headers: h({ "www-authenticate": 'Basic realm="book-advisor"' }) }, "Authentication required")).toMatch(/DASHBOARD_USER/);
    expect(explain401({ status: 401, headers: h({}) }, "<html>Authentication Required</html>")).toMatch(/SWING_API_BYPASS/);
    expect(explain401({ status: 503, headers: h({}) }, "<p>no paper account</p>")).toMatch(/503: no paper account/);
  });
});

describe("swing login check", () => {
  it("trims pasted credentials and reports which gate refused", async () => {
    const { testSwingLogin } = await import("@/lib/scout/swing");
    const env = { SWING_API_URL: "https://swing.example/", SWING_API_USER: " admin ", SWING_API_PASSWORD: "pw\n" } as unknown as NodeJS.ProcessEnv;
    let sent = "";
    const ok = await testSwingLogin(env, (async (url: string, init: RequestInit) => {
      sent = (init.headers as Record<string, string>).authorization;
      expect(url).toBe("https://swing.example/");
      expect(init.method).toBe("GET");
      return new Response("<html/>", { status: 200 });
    }) as unknown as typeof fetch);
    expect(sent).toBe(`Basic ${Buffer.from("admin:pw").toString("base64")}`);
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/trimmed/);
    const bad = await testSwingLogin(env, (async () => new Response("no", { status: 401, headers: { "www-authenticate": "Basic" } })) as unknown as typeof fetch);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/not this app's/);
  });
});
