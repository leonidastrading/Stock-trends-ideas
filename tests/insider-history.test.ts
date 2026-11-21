import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import type { DailyBar } from "@/lib/alpaca";
import { mergeTrades, parseForm4Trades, rangeLine, trackRecord, type Trade } from "@/lib/scout/insider-history";

const tx = (code: string, date: string, shares: number, price: number, after: number) => `<nonDerivativeTransaction><securityTitle><value>Common</value></securityTitle><transactionDate><value>${date}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === "S" ? "D" : "A"}</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>${after}</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>`;
const doc = (...t: string[]) => `<SEC-DOCUMENT><ownershipDocument><issuer><issuerCik>0001999001</issuerCik></issuer>${t.join("")}<nonDerivativeTransaction><transactionDate><value>2026-06-16</value></transactionDate><transactionCoding><transactionCode>A</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>500</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></ownershipDocument></SEC-DOCUMENT>`;

describe("insider history", () => {
  it("reads open-market buys and sales from a Form 4, skipping grants", () => {
    const t = parseForm4Trades(doc(tx("P", "2026-06-16", 150000, 23.4, 4800000), tx("P", "2026-06-16", 100000, 23.6, 4900000), tx("S", "2025-12-01", 50000, 30, 4650000)), "0001-26-000001");
    expect(t.map((x) => [x.side, x.date, x.shares])).toEqual([["buy", "2026-06-16", 150000], ["buy", "2026-06-16", 100000], ["sell", "2025-12-01", 50000]]);
    const m = mergeTrades(t);
    expect(m[0]).toMatchObject({ side: "buy", date: "2026-06-16", shares: 250000, value: 5870000, price: 23.48, ownedAfter: 4900000 });
    expect(m[1]).toMatchObject({ side: "sell", date: "2025-12-01" });
  });

  it("calls out averaging down on a losing earlier buy (the FUN case)", () => {
    const june: Trade = { date: "2026-06-16", side: "buy", shares: 250000, price: 23.48, value: 5870000, ownedAfter: 4900000, plan10b5: false, accession: "a" };
    const line = trackRecord("Rehan Jaffer", [june], 11.55);
    expect(line).toContain("2026-06-16 bought 250,000 at $23.48 ($5.9M), −51% since");
    expect(line).toContain("averaging down on a losing position");
    expect(trackRecord("New Buyer", [], 11.55)).toContain("a first buy");
    const winner: Trade = { ...june, price: 8, value: 2_000_000 };
    expect(trackRecord("Early", [winner], 11.55)).toContain("earlier buys made money");
  });

  it("measures where the stock is in its range", () => {
    const bars: DailyBar[] = Array.from({ length: 250 }, (_, i) => {
      const c = i < 200 ? 25 - i * 0.08 : 9 + (i - 200) * 0.05; // a long slide to $9, then a bounce
      return { symbol: "FUN", date: new Date(Date.UTC(2025, 10, 17) + i * 86400_000).toISOString().slice(0, 10), o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 } as DailyBar;
    });
    const line = rangeLine(bars)!;
    expect(line).toMatch(/above the low/);
    expect(line).toMatch(/from the high/);
    expect(line).toMatch(/Only call a buy "near the lows" if these numbers say so/);
    expect(rangeLine(bars.slice(0, 5))).toBeNull();
  });
});

describe("insider chart data (PGlite, fake SEC)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("every buy and sale by the insiders seen buying, from their Form 4s at the company, one line per day and side", async () => {
    const store = await import("@/lib/scout/store");
    const { insiderTradesFor } = await import("@/lib/scout/insider-history");
    await store.addInsiderBuy({ accession: "0001-26-000009", filed: "2026-11-18", issuerCik: "1999001", symbol: "HMH", issuerName: "HMH Corp", owner: "SMITH JOHN", ownerCik: "1888001", role: "Director", txDate: "2026-11-17", shares: 50000, price: 20, value: 1000000, ownedAfter: 600000, pctIncrease: 9, plan10b5: false, routine: false });
    const subs = (accs: Array<[string, string]>) => Response.json({ filings: { recent: { form: accs.map(() => "4"), accessionNumber: accs.map((a) => a[0]), filingDate: accs.map((a) => a[1]) } } });
    const fetchImpl = (async (url: string) => {
      if (url.includes("CIK0001999001.json")) return subs([["0001-26-000009", "2026-11-18"], ["0001-26-000001", "2026-06-17"]]);
      if (url.includes("CIK0001888001.json")) return subs([["0001-26-000009", "2026-11-18"], ["0001-26-000001", "2026-06-17"], ["0009-25-000777", "2025-01-01"]]);
      if (url.endsWith("0001-26-000001.txt")) return new Response(doc(tx("P", "2026-06-16", 150000, 23.4, 450000), tx("P", "2026-06-16", 100000, 23.6, 550000), tx("S", "2025-12-01", 20000, 30, 300000)));
      if (url.endsWith("0001-26-000009.txt")) return new Response(doc(tx("P", "2026-11-17", 50000, 20, 600000)));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const r = await insiderTradesFor("HMH", "Test test@example.com", fetchImpl);
    expect(r.owners).toEqual([{ cik: "1888001", name: "SMITH JOHN", role: "Director" }]);
    expect(r.trades.map((t) => [t.date, t.side, t.shares, t.price])).toEqual([["2026-11-17", "buy", 50000, 20], ["2026-06-16", "buy", 250000, 23.48], ["2025-12-01", "sell", 20000, 30]]);
    expect(r.trades[0].url).toBe("https://www.sec.gov/Archives/edgar/data/1999001/000126000009/");
  });
});
