import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import * as store from "@/lib/scout/store";
import { estimateNextEarnings, refreshSymbolInfo } from "@/lib/scout/symbols";

describe("next earnings estimate", () => {
  it("last release plus the usual quarterly gap", () => {
    const e = estimateNextEarnings(["2025-10-30", "2026-01-29", "2026-04-30", "2026-07-30", "2026-10-29"], "2026-11-14");
    expect(e).toMatchObject({ last: "2026-10-29", next: "2027-01-28" });
    expect(e.basis).toMatch(/est\. from 5 past releases, usual gap 91 days/);
  });
  it("ignores 8-K/A noise and odd gaps, rolls forward past a missed one, and stays empty without history", () => {
    expect(estimateNextEarnings(["2026-04-30", "2026-05-02", "2026-07-30"], "2026-08-15").next).toBe("2026-10-27"); // the 2-day gap is not a quarter; 89 days is
    expect(estimateNextEarnings(["2025-11-03", "2026-02-02", "2026-05-04"], "2026-11-06").next).toBe("2026-11-02"); // 91-day steps: Aug 3 missed, Nov 2 is within a week
    expect(estimateNextEarnings(["2026-10-29"], "2026-11-14")).toEqual({ last: "2026-10-29", next: null, basis: null });
    expect(estimateNextEarnings([], "2026-11-14").last).toBeNull();
  });
});

describe("symbol info (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("stores the name a symbol trades as today and its earnings, once a day", async () => {
    let assetCalls = 0;
    const data = {
      getDailyBars: async () => [], getNews: async () => [], getCalendar: async () => [],
      getAsset: async (s: string) => { assetCalls++; return s === "SATS" ? { symbol: s, name: "Strive, Inc. 15% Series A Perpetual SATS Preferred Stock", exchange: "NASDAQ", active: true, tradable: true } : s === "COIN" ? { symbol: s, name: "Coinbase Global, Inc. Class A Common Stock", exchange: "NASDAQ", active: true, tradable: true } : null; },
    } as MarketData;
    const sec = (async (url: string) => {
      if (url.includes("company_tickers")) return new Response(JSON.stringify({ 0: { cik_str: 1679788, ticker: "COIN", title: "Coinbase Global, Inc." } }));
      return new Response(JSON.stringify({ cik: "1679788", filings: { recent: { accessionNumber: ["a", "b", "c"], filingDate: ["2026-10-30", "2026-07-31", "2026-05-01"], form: ["8-K", "8-K", "8-K"], items: ["2.02,9.01", "2.02", "2.02"], primaryDocument: ["x", "x", "x"] } } }));
    }) as unknown as typeof fetch;
    const env = { SEC_USER_AGENT: "Test test@example.com" } as unknown as NodeJS.ProcessEnv;
    const r = await refreshSymbolInfo(data, env, ["COIN", "SATS", "ZZZZ", "COIN"], new Date("2026-11-14T15:00:00Z"), 20, sec);
    expect(r.checked).toBe(3);
    const info = await store.symbolInfo(["COIN", "SATS", "ZZZZ"]);
    expect(info.get("COIN")).toMatchObject({ name: "Coinbase Global, Inc. Class A Common Stock", lastEarnings: "2026-10-30", nextEarnings: "2027-01-29" });
    expect(info.get("SATS")?.name).toMatch(/Strive.*Preferred/);
    expect(info.get("ZZZZ")).toMatchObject({ name: "(not a listed symbol now)", tradable: false });
    await refreshSymbolInfo(data, env, ["COIN"], new Date("2026-11-14T16:00:00Z"), 20, sec);
    expect(assetCalls).toBe(3); // fresh within 20 hours: not looked up again
  });
});
