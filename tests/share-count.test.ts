import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { SYSTEM_PROMPT } from "@/lib/scout/prompt";
import { lastBuyback, shareCountText, shareTrend, shareTrendFrom, shareTrendOnFile, shareVerdict, type SharePoint, type ShareTrend } from "@/lib/scout/share-count";

const pt = (end: string, val: number, accn = `a-${end}`, filed = end): SharePoint => ({ end, val, accn, filed });

describe("is the company buying itself back?", () => {
  it("the share count now, a year back and three years back, from the covers of its reports", () => {
    const t = shareTrendFrom([pt("2023-10-25", 120e6), pt("2024-10-28", 110e6), pt("2025-07-30", 101e6), pt("2025-10-27", 100e6), pt("2026-07-29", 95e6), pt("2026-10-28", 93.9e6)])!;
    expect(t).toEqual({ shares: 93.9e6, asOf: "2026-10-28", yr1Pct: -6.1, yr3Pct: -21.8 });
    // A newer filing that restates a date replaces the older one; no filing a year back gives no change.
    expect(shareTrendFrom([pt("2026-10-28", 90e6, "old", "2026-11-01"), pt("2026-10-28", 93.9e6, "new", "2026-11-20")])).toEqual({ shares: 93.9e6, asOf: "2026-10-28", yr1Pct: null, yr3Pct: null });
    expect(shareTrendFrom([])).toBeNull();
  });

  it("adds up the share classes one filing reports for the same date", () => {
    const t = shareTrendFrom([pt("2025-10-20", 300e6, "k1"), pt("2025-10-20", 50e6, "k1"), pt("2026-10-20", 280e6, "k2"), pt("2026-10-20", 49e6, "k2")])!;
    expect([t.shares, t.yr1Pct]).toEqual([329e6, -6]);
  });

  it("reads the trend: shrinking, growing, steady, or a split that is neither", () => {
    expect(shareVerdict({ yr1Pct: -6.1 })).toBe("shrinking");
    expect(shareVerdict({ yr1Pct: 14 })).toBe("growing");
    expect(shareVerdict({ yr1Pct: -1.2 })).toBe("steady");
    expect(shareVerdict({ yr1Pct: 100 })).toBe("split");
    expect(shareVerdict({ yr1Pct: -90 })).toBe("split"); // a reverse split is not a buyback
    expect(shareVerdict({ yr1Pct: null })).toBe("unknown");
  });

  it("takes the last full fiscal year's repurchases from the annual report", () => {
    expect(lastBuyback([{ end: "2024-12-31", val: 300e6, form: "10-K", fp: "FY" }, { end: "2025-12-31", val: 420e6, form: "10-K", fp: "FY" }, { end: "2026-09-30", val: 310e6, form: "10-Q", fp: "Q3" }])).toEqual({ usd: 420e6, fy: "2025" });
    expect(lastBuyback([{ end: "2025-12-31", val: 0, form: "10-K", fp: "FY" }])).toBeNull();
  });

  const trend: ShareTrend = { symbol: "HLF", at: "2026-11-26T00:00:00Z", shares: 93.9e6, asOf: "2026-10-28", yr1Pct: -6.1, yr3Pct: -21.8, buyback: { usd: 420e6, fy: "2025" } };

  it("tells research what a shrinking count means for a short, most of all a crowded one", () => {
    const t = shareCountText(trend, 24, 1.6e9);
    expect(t).toMatch(/^SHARE COUNT \(the SEC's own data, measured by the scout's code; not a source\): HLF had 93\.9M shares at 2026-10-28, -6\.1% in a year, -21\.8% in three years\. It paid \$420M for its own shares in fiscal 2025, about 26\.3% of today's market value\./);
    expect(t).toContain("a steady buyer under the price, and fewer shares left to borrow and buy back, with 24% of the float already sold short");
    expect(t).toContain("A short here needs a dated catalyst");
    // Few shares short: the headwind is named without the squeeze.
    expect(shareCountText(trend, 3)).not.toContain("already sold short");
    // Steady: the facts only. Dilution and splits are named for what they are.
    expect(shareCountText({ ...trend, yr1Pct: -0.8, yr3Pct: -2, buyback: null })).toBe("SHARE COUNT (the SEC's own data, measured by the scout's code; not a source): HLF had 93.9M shares at 2026-10-28, -0.8% in a year, -2% in three years.");
    expect(shareCountText({ ...trend, yr1Pct: 22 })).toContain("issuing shares (dilution), a headwind for a long");
    expect(shareCountText({ ...trend, yr1Pct: 100 })).toContain("a stock split, a merger or a large issue, not buybacks");
    expect(SYSTEM_PROMPT).toContain("Being right about a business is not the same as making money on a short.");
  });
});

describe("reading the share count from the SEC (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("two small requests, kept for days; a company the SEC does not list is remembered as unknown", async () => {
    let calls = 0;
    const sec = (async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers")) return Response.json({ 0: { cik_str: 1180262, ticker: "HLF", title: "Herbalife Ltd." } });
      calls++;
      if (u.includes("/dei/EntityCommonStockSharesOutstanding")) return Response.json({ units: { shares: [pt("2025-10-27", 100e6), pt("2026-10-28", 93.9e6)] } });
      if (u.includes("/us-gaap/PaymentsForRepurchaseOfCommonStock")) return Response.json({ units: { USD: [{ end: "2025-12-31", val: 420e6, form: "10-K", fp: "FY" }] } });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const env = { SEC_USER_AGENT: "ua" } as unknown as NodeJS.ProcessEnv, now = new Date("2026-11-26T15:00:00Z");
    const t = await shareTrend("HLF", env, now, sec);
    expect(t).toMatchObject({ symbol: "HLF", shares: 93.9e6, yr1Pct: -6.1, buyback: { usd: 420e6, fy: "2025" } });
    expect(calls).toBe(2);
    expect(await shareTrend("HLF", env, now, sec)).toMatchObject({ yr1Pct: -6.1 });
    expect(calls).toBe(2); // from the cache
    expect(await shareTrendOnFile("HLF")).toMatchObject({ shares: 93.9e6 });
    expect(await shareTrend("NOPE", env, now, sec)).toBeNull();
    expect(await shareTrendOnFile("NOPE")).toBeNull();
  });
});
