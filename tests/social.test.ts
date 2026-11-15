import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { clearHttpCache } from "@/lib/http";
import { moversFromBars, moversPanel, plainMover, retailGreed, socialPanel, streamStats } from "@/lib/market/social";
import * as store from "@/lib/scout/store";

const now = new Date("2026-11-16T18:00:00Z");
const msg = (minsAgo: number, sentiment?: "Bullish" | "Bearish") => ({ id: minsAgo, created_at: new Date(now.getTime() - minsAgo * 60000).toISOString(), entities: sentiment ? { sentiment: { basic: sentiment } } : {} });

describe("home-page widgets", () => {
  it("movers: common stock at $1+, and a fallback from daily bars", () => {
    expect([{ symbol: "BGIN", price: 3.88 }, { symbol: "ABCDW", price: 1.2 }, { symbol: "XY.WS", price: 2 }, { symbol: "PENNY", price: 0.4 }].filter(plainMover).map((m) => m.symbol)).toEqual(["BGIN", "ABCDW"]);
    const bar = (symbol: string, date: string, c: number, v = 1000): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v });
    const by = new Map([["MOD", [bar("MOD", "2026-11-12", 100), bar("MOD", "2026-11-13", 127.86, 8_400_000)]], ["SPGI", [bar("SPGI", "2026-11-12", 500), bar("SPGI", "2026-11-13", 480)]]]);
    const m = moversFromBars(by);
    expect(m.gainers[0]).toEqual({ symbol: "MOD", price: 127.86, changePct: 27.86, volume: 8_400_000 });
    expect(m.losers[0]).toMatchObject({ symbol: "SPGI", changePct: -4 });
  });

  it("movers from Alpaca's screener, with volume from snapshots", async () => {
    const data = {
      getMovers: async () => ({ gainers: [{ symbol: "BGIN", price: 3.88, changePct: 40.583 }, { symbol: "ZZZW", price: 0.5, changePct: 90 }], losers: [{ symbol: "OCUL", price: 9, changePct: -12 }] }),
      getSnapshots: async () => ({ BGIN: { price: 3.88, at: null, prevClose: 2.76, sessionDate: "2026-11-16", volume: 504_000 } }),
    } as unknown as MarketData;
    expect(await moversPanel(now, data)).toEqual({ gainers: [{ symbol: "BGIN", price: 3.88, changePct: 40.58, volume: 504_000 }], losers: [{ symbol: "OCUL", price: 9, changePct: -12, volume: null }], scope: "all US stocks" });
  });

  it("Stocktwits stream stats and retail greed", () => {
    const s = streamStats([msg(10, "Bullish"), msg(20, "Bullish"), msg(30, "Bearish"), msg(60), msg(120)], now);
    expect(s).toEqual({ posts: 5, perHour: 2.5, bullish: 2, bearish: 1 });
    expect(retailGreed(28, 72)).toBe(28);
    expect(retailGreed(3, 2)).toBeNull(); // too few tagged posts to say
  });
});

describe("socialPanel (PGlite, fake Stocktwits)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("ranks trending stocks with posts an hour, bullish/bearish shares and IT/CT tags", async () => {
    clearHttpCache();
    await store.addInsiderBuy({ accession: "a", filed: "2026-11-10", issuerCik: null, symbol: "MSTR", issuerName: "Strategy", owner: "X", ownerCik: null, role: "Director", txDate: "2026-11-07", shares: 1, price: 1, value: 1, ownedAfter: null, pctIncrease: null, plan10b5: false, routine: false });
    const fake = (async (url: string) => {
      const u = String(url);
      if (u.includes("/trending/")) return new Response(JSON.stringify({ symbols: [{ symbol: "BMNR", title: "Bitmine", watchlist_count: 29379 }, { symbol: "MSTR", title: "Strategy Inc", watchlist_count: 83694 }] }));
      const many = (b: number, br: number) => [...Array(b).fill("Bullish"), ...Array(br).fill("Bearish"), ...Array(10).fill(undefined)].map((s, i) => msg(i * 6, s));
      return new Response(JSON.stringify(u.includes("BMNR") ? { symbol: { title: "Bitmine Immersion", watchlist_count: 29400 }, messages: many(12, 3) } : { messages: many(4, 11) }));
    }) as unknown as typeof fetch;
    const s = await socialPanel(now, fake);
    expect(s.rows.map((r) => [r.symbol, r.rank, r.company, r.watchers, r.bullishPct, r.bearishPct, r.insider, r.congress])).toEqual([
      ["BMNR", 1, "Bitmine Immersion", 29400, 48, 12, false, false],
      ["MSTR", 2, "Strategy Inc", 83694, 16, 44, true, false],
    ]);
    expect(s.retailGreed).toBe(53); // 16 bullish of 30 tagged
    expect(s.rows[0].rankChange).toBeNull(); // no list from a day ago yet
  });
});
