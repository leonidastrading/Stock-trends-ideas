import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData, NewsItem } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { runUpgrades, tradable, upgradeBook, upgradeInfo, upgradeResult, upgradesIn } from "@/lib/scout/upgrades";

describe("reading an upgrade headline", () => {
  it("a broker upgrading a stock to a buy rating, and nothing else", () => {
    expect(upgradeInfo("RBC Capital Markets Upgrades Sanofi to Outperform")).toEqual({ broker: "RBC Capital Markets", to: "Outperform", from: null, topBroker: true });
    expect(upgradeInfo("Argus Upgrades HCA Healthcare to Buy From Hold")).toEqual({ broker: "Argus", to: "Buy", from: "Hold", topBroker: false });
    // To Neutral is not a buy rating; a downgrade, a price target and a credit rating are not upgrades of the stock.
    expect(upgradeInfo("UBS Upgrades Shoals Technologies Group to Neutral From Sell")).toBeNull();
    expect(upgradeInfo("Argus Downgrades HCA Healthcare to Sell From Buy")).toBeNull();
    expect(upgradeInfo("Daiwa Securities Adjusts Intuit Price Target to $325 From $400")).toBeNull();
    expect(upgradeInfo("Moody's Upgrades Ford Credit Rating to Positive")).toBeNull();
  });

  it("one row per stock and day; round-ups naming several stocks are left out", () => {
    const n = (ts: string, headline: string, symbols: string[]): Pick<NewsItem, "ts" | "headline" | "symbols" | "url"> => ({ ts, headline, symbols, url: "https://example.com/n" });
    const rows = upgradesIn([
      n("2026-11-25T14:02:00Z", "RBC Capital Markets Upgrades Sanofi to Outperform", ["SNY"]),
      n("2026-11-25T15:30:00Z", "Barclays Upgrades Sanofi to Overweight", ["SNY"]),
      n("2026-11-25T15:31:00Z", "Analysts Upgrade Apple and Microsoft to Buy", ["AAPL", "MSFT"]),
      n("2026-11-25T16:00:00Z", "Sanofi Shares Rise", ["SNY"]),
    ]);
    expect(rows).toEqual([{ symbol: "SNY", day: "2026-11-25", brokers: ["RBC Capital Markets", "Barclays"], to: "Outperform", from: null, topBroker: true, headline: "RBC Capital Markets Upgrades Sanofi to Outperform", url: "https://example.com/n", newsAt: "2026-11-25T14:02:00Z" }]);
  });

  it("small and thinly traded stocks are left out", () => {
    const bars = (c: number, v: number) => Array.from({ length: 25 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, c, v }));
    expect(tradable(bars(50, 1e6), "2026-11-25")).toEqual({ ok: true, prevClose: 50 });
    expect(tradable(bars(3, 1e7), "2026-11-25").ok).toBe(false);
    expect(tradable(bars(50, 1000), "2026-11-25").ok).toBe(false);
    expect(tradable([], "2026-11-25")).toEqual({ ok: false, prevClose: null });
  });
});

describe("the upgrades list (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  const bar = (symbol: string, date: string, o: number, c: number): DailyBar => ({ symbol, date, o, h: o, l: c, c, v: 5e6 });
  const history = (symbol: string, c: number) => Array.from({ length: 16 }, (_, i) => bar(symbol, `2026-11-${String(i + 2).padStart(2, "0")}`, c, c)).filter((b) => ![0, 6].includes(new Date(`${b.date}T12:00:00Z`).getUTCDay()));
  const bars = [...history("SNY", 49), ...history("LIVE", 20), bar("SNY", "2026-11-24", 50.3, 51.9), bar("SNY", "2026-11-25", 53.6, 54.39), bar("SPY", "2026-11-25", 700, 705), bar("SNY", "2027-02-17", 60, 61), bar("SPY", "2027-02-17", 720, 721), bar("LIVE", "2026-11-24", 20, 20), bar("LIVE", "2026-11-25", 20, 20)];
  const news: NewsItem[] = [
    { id: 1, ts: "2026-11-25T14:02:00Z", headline: "RBC Capital Markets Upgrades Sanofi to Outperform", summary: "", symbols: ["SNY"], source: "x", url: "https://example.com/sny" },
    { id: 2, ts: "2026-11-25T15:20:00Z", headline: "Jefferies Upgrades Live Co to Buy", summary: "", symbols: ["LIVE"], source: "x", url: "" },
  ];
  const data = {
    getNews: async (_s: string[], start: Date, end: Date) => news.filter((n) => new Date(n.ts) >= start && new Date(n.ts) <= end),
    getDailyBars: async (symbols: readonly string[], start: string, end: string) => bars.filter((b) => symbols.includes(b.symbol) && b.date >= start && b.date <= end),
    getSnapshots: async () => ({ LIVE: { price: 21.5 }, SNY: { price: 54 }, SPY: { price: 703 } }),
  } as unknown as MarketData;

  it("an upgrade before the bell enters at that day's open; one during the session at the live price", async () => {
    // 9:10 AM ET: only the SNY upgrade is out, the market is closed.
    expect(await runUpgrades(data, new Date("2026-11-25T14:10:00Z"))).toMatch(/^upgrades: 1 in the last 30 hours of headlines, 1 new, 0 entered at an open, 0 closed · 1 open/);
    expect((await upgradeBook(4000))[0]).toMatchObject({ symbol: "SNY", day: "2026-11-25", entryDate: null, basis: "open", prevClose: 51.9, topBroker: true });
    // 10:30 AM ET: SNY's open is known, and LIVE's upgrade has just appeared.
    expect(await runUpgrades(data, new Date("2026-11-25T15:30:00Z"))).toMatch(/2 in the last 30 hours of headlines, 1 new, 1 entered at an open, 0 closed · 2 open/);
    const book = await upgradeBook(4000);
    expect(book.find((u) => u.symbol === "SNY")).toMatchObject({ entryDate: "2026-11-25", entryPrice: 53.6, spyEntry: 700, exitBy: "2027-02-17" });
    expect(book.find((u) => u.symbol === "LIVE")).toMatchObject({ entryDate: "2026-11-25", entryPrice: 21.5, spyEntry: 703, basis: "listing" });
    // A later pass adds nothing and changes no entry.
    expect(await runUpgrades(data, new Date("2026-11-25T16:30:00Z"))).toMatch(/0 new, 0 entered at an open/);
    const r = upgradeResult(book.find((u) => u.symbol === "SNY")!, 54.39, 705, new Date("2026-11-25T21:00:00Z"))!;
    expect([Math.round(r.ret * 1000) / 10, Math.round(r.vsSpy! * 1000) / 10]).toEqual([1.5, 0.8]);
  });

  it("closes after the hold, at that session's close", async () => {
    expect(await runUpgrades(data, new Date("2027-02-18T15:00:00Z"))).toMatch(/1 closed/);
    const sny = (await upgradeBook(4000)).find((u) => u.symbol === "SNY")!;
    expect([sny.exitDate, sny.exitPrice, sny.spyExit]).toEqual(["2027-02-17", 61, 721]);
    expect(Math.round(upgradeResult(sny, null, null)!.ret * 1000) / 10).toBe(13.8);
  });
});
