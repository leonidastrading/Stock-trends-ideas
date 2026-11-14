import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { buyResults, byMember, bySymbol, pickReports } from "@/lib/scout/congress";
import * as store from "@/lib/scout/store";
import type { CongressTradeRow } from "@/lib/scout/store";
import { amountRange, isScanned, parseHouseIndex, parsePtrText, unzip } from "@/lib/sources/house";

// A real index zip's layout (deflated XML with a byte-order mark), built with Python's zipfile.
const ZIP = "UEsDBBQAAAAIALG7bl07jczUCgAAAAgAAAAKAAAAMjAyNkZELnR4dMvLL1EoLU5NAQBQSwMEFAAAAAgAsbtuXT5OmrngAAAA2gEAAAoAAAAyMDI2RkQueG1sjZHBagIxEIZfRXwAJ1lZ6WEaEYNoqSDooR7TZVYD2USS3aLP1kMfqa/QZFellUp7yzf/ZJiP+Xz/wPGxMr038kE7+9jnA9YfC5xpq2yhlZE6FMaFxpPAJVWv5AWuPJX6KObODhDOgM8q1OLJ7W1wFqGlOMWnYmM0IXSA66aM/T1IqdF2tzkdSKxSfCVc16omGbs3L8MM4Yq4JeVFxrIRQvs8z5AxF5wDZ9CF38ooXbGQ8RMb5g8sZh0jXGx+WqXF2uWloxsNZf+wmN6xmE4Y/69FDvyuA2csDboVgN+O9QVQSwECFAMUAAAACACxu25dO43M1AoAAAAIAAAACgAAAAAAAAAAAAAAgAEAAAAAMjAyNkZELnR4dFBLAQIUAxQAAAAIALG7bl0+Tpq54AAAANoBAAAKAAAAAAAAAAAAAACAATIAAAAyMDI2RkQueG1sUEsFBgAAAAACAAIAcAAAADoBAAAAAA==";

// Text layers of real reports (House Clerk, Nov 2026), as unpdf extracts them: rows wrap, bonds have no ticker.
const JOHNSON = `Name: Hon. Julie Johnson
Status: Member
State/District: TX32
ID Owner Asset Transaction
Type
Date Notification
Date
Amount Cap.
Gains >
$200?
JT Warner Bros. Discovery, Inc. - Series
A Common Stock (WBD) [ST]
S 10/07/2026 11/09/2026 $1,001 - $15,000
F S: New
S O: Merrill Lynch Tax Efficient Core
* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx.
Filing ID #20035806`;

const JACKSON = `ID Owner Asset Transaction
Type
Date Notification
Date
Amount Cap.
Gains >
$200?
JT Datadog, Inc. - Class A Common
Stock (DDOG) [ST]
P 09/28/2026 10/01/2026 $50,001 -
$100,000
F S: New
SP Tortoise Energy Infrastructure
[ST]
S 09/04/2026 10/01/2026 $1,001 - $15,000
F S: New
US Treasury Note 4% DUE 7/31/29 (91282CLC3) [GS] P 10/02/2026 11/10/2026 $15,001 - $50,000
SP Micron Technology, Inc. - Common
Stock (MU) [ST]
S (partial) 09/25/2026 10/02/2026 $1,001 - $15,000
Filing ID #20035551
ID Owner Asset Transaction
Type
Amount Cap.
Gains >
$200?
NVIDIA Corporation - Common Stock
(NVDA) [OP]
P 09/29/2026 10/01/2026 Over $50,000,000
D: Purchased 20 call options`;

describe("House Clerk sources", () => {
  it("reads the yearly index zip: periodic transaction reports only", () => {
    const files = unzip(Uint8Array.from(Buffer.from(ZIP, "base64")));
    expect([...files.keys()].sort()).toEqual(["2026FD.txt", "2026FD.xml"]);
    const xml = new TextDecoder().decode(files.get("2026FD.xml")!).replace(/^﻿/, "");
    expect(parseHouseIndex(xml)).toEqual([{ docId: "20035806", member: "Julie Johnson", stateDst: "TX32", filed: "2026-11-10", year: 2026 }]);
    expect(() => unzip(new Uint8Array(40))).toThrow(/not a zip/);
  });

  it("parses wrapped rows, owners, options and amount ranges; skips bonds and untickered assets", () => {
    expect(parsePtrText(JOHNSON)).toEqual([{ ord: 0, owner: "joint", symbol: "WBD", assetType: "stock", tx: "sell", txDate: "2026-10-07", notified: "2026-11-09", amountLow: 1001, amountHigh: 15000, amount: "$1,001 - $15,000" }]);
    const j = parsePtrText(JACKSON);
    expect(j.map((t) => [t.symbol, t.owner, t.tx, t.assetType, t.amountLow, t.amountHigh])).toEqual([
      ["DDOG", "joint", "buy", "stock", 50001, 100000],
      ["MU", "spouse", "partial sale", "stock", 1001, 15000],
      ["NVDA", "self", "buy", "option", 50000001, null],
    ]);
    expect(amountRange("$1,000,001 - $5,000,000")).toEqual({ low: 1000001, high: 5000000 });
    expect(isScanned("   \n ")).toBe(true);
    expect(isScanned(JOHNSON)).toBe(false);
  });
});

const T = (o: Partial<CongressTradeRow>): CongressTradeRow => ({ docId: "1", ord: 0, chamber: "House", member: "A", stateDst: "TX01", filed: "2026-11-01", owner: "self", symbol: "MU", assetType: "stock", tx: "buy", txDate: "2026-10-20", notified: "2026-10-30", amountLow: 1001, amountHigh: 15000, amount: "$1,001 - $15,000", ...o });

describe("Congress signals", () => {
  it("picks unread reports in the look-back, newest first", () => {
    const f = (docId: string, filed: string) => ({ docId, member: "X", stateDst: "", filed, year: 2026 });
    expect(pickReports([f("1", "2026-11-10"), f("2", "2026-11-12"), f("3", "2026-05-01"), f("4", "2026-11-11")], new Set(["4"]), "2026-11-14").map((x) => x.docId)).toEqual(["2", "1"]);
  });

  it("clusters: three members buying, or two with $100k+; more sellers cancel it", () => {
    const a = bySymbol([
      T({ member: "A" }), T({ member: "B", docId: "2" }), T({ member: "C", docId: "3" }),
      T({ member: "A", symbol: "AVGO", amountLow: 100001, amountHigh: 250000 }), T({ member: "B", symbol: "AVGO", docId: "2" }),
      T({ member: "A", symbol: "WMT" }), T({ member: "B", symbol: "WMT", tx: "sell", docId: "2" }), T({ member: "C", symbol: "WMT", tx: "partial sale", docId: "3" }),
      T({ member: "D", symbol: "OLD", filed: "2026-09-01" }),
    ], "2026-10-15");
    expect(a.map((x) => [x.symbol, x.buyers.length, x.cluster])).toEqual([["MU", 3, true], ["AVGO", 2, true], ["WMT", 1, false]]);
    expect(a[1].buyUsd).toBe(175000.5 + 8000.5);
  });

  it("members: trades, reports and the typical reporting delay", () => {
    const m = byMember([T({ txDate: "2026-10-01" }), T({ ord: 1, txDate: "2026-10-31" }), T({ docId: "2", ord: 0, txDate: "2026-10-26", tx: "sell" }), T({ member: "B" })]);
    expect(m[0]).toMatchObject({ member: "A", trades: 3, buys: 2, sells: 1, reports: 2, medianLagDays: 6 });
  });

  it("returns since the trade and since the filing, against SPY", () => {
    const bars = (sym: string, closes: Array<[string, number]>): DailyBar[] => closes.map(([date, c]) => ({ symbol: sym, date, o: c, h: c, l: c, c, v: 1 }));
    const m = new Map([["MU", bars("MU", [["2026-10-20", 100], ["2026-11-02", 110], ["2026-11-13", 121]])], ["SPY", bars("SPY", [["2026-10-20", 600], ["2026-11-02", 600], ["2026-11-13", 612]])]]);
    expect(buyResults([T({})], m)[0]).toMatchObject({ sinceTrade: 21, sinceTradeVsSpy: 19, sinceFiling: 10, sinceFilingVsSpy: 8, asOf: "2026-11-13" });
    expect(buyResults([T({ symbol: "ZZZ" })], m)[0].sinceFiling).toBeNull();
  });
});

describe("Congress store (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("stores a report once with its trades; both tables are append-only", async () => {
    const f = { docId: "20035806", chamber: "House", member: "Julie Johnson", stateDst: "TX32", filed: "2026-11-10", year: 2026, status: "read" };
    await store.addCongressFiling(f, [T({ docId: "20035806", member: "Julie Johnson", filed: "2026-11-10" })]);
    await store.addCongressFiling(f, [T({ docId: "20035806", member: "Julie Johnson", filed: "2026-11-10" })]);
    expect(await store.congressSeen()).toEqual(new Set(["20035806"]));
    const rows = await store.congressTradesSince("2026-11-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "MU", year: 2026, amountHigh: 15000 });
    expect(await store.congressFilingsStatus()).toMatchObject({ read: 1, withTrades: 1, latest: "2026-11-10" });
    await expect(pg.query("UPDATE congress_trades SET symbol = 'X'")).rejects.toThrow(/append-only/);
    await expect(pg.query("DELETE FROM congress_filings")).rejects.toThrow(/append-only/);
  });
});
