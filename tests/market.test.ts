import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { breadth, businessDaysFrom, buzzScore, panel } from "@/lib/market/panels";
import { contractorTicker, parseNasdaqEarnings, parseTreasuryCsv } from "@/lib/market/sources";
import * as store from "@/lib/scout/store";

describe("dashboard sources (shapes seen from Vercel's network, 2026-11-14)", () => {
  it("Treasury yield curve CSV: newest row and the one before", () => {
    const csv = `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
11/13/2026,4.10,4.18,4.26,4.32,4.34,4.42,4.65,4.88,4.92,4.98,5.05,5.15,5.52,5.47
11/12/2026,4.12,4.18,4.26,4.32,4.35,4.42,4.65,4.86,4.90,4.95,5.02,5.10,5.48,5.43`;
    expect(parseTreasuryCsv(csv)).toEqual({ date: "2026-11-13", y10: 5.15, y30: 5.47, prev10: 5.1, prev30: 5.43 });
    expect(parseTreasuryCsv("Date,x\n1/1/2026,1")).toBeNull();
  });

  it("Nasdaq earnings calendar rows", () => {
    const rows = parseNasdaqEarnings({ data: { rows: [
      { symbol: "NVDA", name: "NVIDIA Corporation", marketCap: "$4,100,000,000,000", epsForecast: "$2.47", time: "time-after-hours" },
      { symbol: "WMT", name: "Walmart Inc.", marketCap: "$790,000,000,000", epsForecast: "$0.63", time: "time-pre-market" },
      { symbol: "", name: "junk", marketCap: "", epsForecast: "", time: "time-not-supplied" },
    ] } }, "2026-11-17");
    expect(rows).toEqual([
      { date: "2026-11-17", symbol: "NVDA", name: "NVIDIA Corporation", marketCap: 4.1e12, eps: "$2.47", time: "after close" },
      { date: "2026-11-17", symbol: "WMT", name: "Walmart Inc.", marketCap: 7.9e11, eps: "$0.63", time: "before open" },
    ]);
    expect(parseNasdaqEarnings({ data: { rows: null } }, "2026-11-17")).toEqual([]);
  });

  it("contract recipients → listed parents: aliases, confident name matches, and no guessing", () => {
    const sec = [{ ticker: "IBM", title: "INTERNATIONAL BUSINESS MACHINES CORP" }, { ticker: "GIB", title: "CGI INC" }, { ticker: "GM", title: "General Motors Co" }, { ticker: "CACI", title: "CACI INTERNATIONAL INC /DE/" }, { ticker: "BAH", title: "Booz Allen Hamilton Holding Corp" }];
    expect(contractorTicker("INTERNATIONAL BUSINESS MACHINES CORPORATION", sec)).toBe("IBM");
    expect(contractorTicker("RAYTHEON COMPANY", sec)).toBe("RTX");
    expect(contractorTicker("CGI FEDERAL INC.", sec)).toBe("GIB");
    expect(contractorTicker("CACI, INC. - FEDERAL", sec)).toBe("CACI");
    expect(contractorTicker("GENERAL DYNAMICS INFORMATION TECHNOLOGY, INC.", sec)).toBe("GD"); // not General Motors
    expect(contractorTicker("GENERAL ATOMICS", sec)).toBeNull(); // private; "general" alone is too generic
    expect(contractorTicker("BECHTEL NATIONAL, INC.", sec)).toBeNull(); // private
    expect(contractorTicker("STONEX FINANCIAL LTD", sec)).toBeNull();
  });
});

describe("panels", () => {
  it("business days skip weekends", () => {
    expect(businessDaysFrom("2026-11-14", 5)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
  });

  it("buzz score out of 20", () => {
    expect(buzzScore({ chatterZ: 4.2, news: 30, newsAvg: 5, trendingRank: 3 })).toEqual({ score: 20, parts: "chatter 8/8 · news 6/6 · trending 6/6" });
    expect(buzzScore({ chatterZ: 1, news: 2, newsAvg: 1, trendingRank: 25 })).toEqual({ score: 5, parts: "chatter 2/8 · news 0/6 · trending 3/6" });
    expect(buzzScore({ chatterZ: null, news: null, newsAvg: null, trendingRank: null }).score).toBe(0);
  });

  it("breadth: advancing / declining, 52-week highs and lows, mood", () => {
    const series = (sym: string, last: number) => Array.from({ length: 200 }, (_, i): DailyBar => ({ symbol: sym, date: `2026-${String(Math.floor(i / 28) + 3).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, o: 100, h: 101, l: 99, c: i === 199 ? last : 100, v: 1 }));
    const by = new Map([["UP", series("UP", 110)], ["DOWN", series("DOWN", 90)], ["FLAT", series("FLAT", 100)]]);
    const spy = Array.from({ length: 130 }, (_, i): DailyBar => ({ symbol: "SPY", date: `d${i}`, o: 600, h: 600, l: 600, c: i === 129 ? 630 : 600, v: 1 }));
    const b = breadth(by, spy, 15, 20)!;
    expect(b).toMatchObject({ stocks: 3, advancing: 1, declining: 1, highs: 1, lows: 1 });
    expect(b.mood).toBeGreaterThan(50); // SPY above its average and VIX below its own
    expect(b.parts).toMatch(/advancing 50 · highs vs lows 50 · S&P vs 125-day average \d+ · VIX vs its 1-year average 75/);
    expect(breadth(new Map(), [], null, null)).toBeNull();
  });
});

describe("panel cache and confirmed earnings (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("fresh copy is reused; a failing refresh falls back to the last good copy", async () => {
    let calls = 0;
    const a = await panel("t", 60, async () => { calls++; return [1, 2]; });
    const b = await panel("t", 60, async () => { calls++; return [3]; });
    expect([a.data, b.data, calls]).toEqual([[1, 2], [1, 2], 1]);
    await pg.query(`UPDATE dashboard_cache SET updated_at = now() - interval '2 hours'`);
    const c = await panel("t", 60, async () => { throw new Error("Nasdaq down"); });
    expect(c).toMatchObject({ data: [1, 2], error: "Nasdaq down" });
  });

  it("a confirmed calendar date is not overwritten by the next estimate", async () => {
    await store.upsertSymbolInfo({ symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", tradable: true, lastEarnings: "2026-08-27", nextEarnings: "2026-11-20", nextBasis: "est. from 5 past releases" });
    await store.confirmEarnings("NVDA", "2099-11-17", "confirmed (Nasdaq calendar, after close)");
    await store.upsertSymbolInfo({ symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", tradable: true, lastEarnings: "2026-08-27", nextEarnings: "2099-11-20", nextBasis: "est. from 5 past releases" });
    expect((await store.symbolInfo(["NVDA"])).get("NVDA")).toMatchObject({ nextEarnings: "2099-11-17", nextBasis: "confirmed (Nasdaq calendar, after close)" });
  });
});
