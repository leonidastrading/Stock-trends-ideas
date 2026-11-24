import { describe, expect, it } from "vitest";
import { cardsBySymbol, tickerList, typedTickers, type CardOnFile } from "../lib/scout/cards-on-file";

describe("existing cards shown while a ticker is typed", () => {
  it("reads the tickers out of what was typed", () => {
    expect(typedTickers("orcl, $crwv  KGS")).toEqual(["ORCL", "CRWV", "KGS"]);
    expect(typedTickers("kgs kgs BRK.B toolongname 123")).toEqual(["KGS", "BRK.B"]);
    expect(typedTickers("a b c d e f g")).toHaveLength(5);
    expect(typedTickers("  ")).toEqual([]);
  });
  it("knows a pasted list of tickers from a single search", () => {
    expect(tickerList("AFRM, RMIX, APC, CAKE, FXI")).toEqual(["AFRM", "RMIX", "APC", "CAKE", "FXI"]);
    expect(tickerList("afrm, cake")).toEqual(["AFRM", "CAKE"]); // commas make it a list in any case
    expect(tickerList("AFRM CAKE FXI HII")).toEqual(["AFRM", "CAKE", "FXI", "HII"]); // three or more, in capitals
    expect(tickerList("AFRM, $CAKE; fxi")).toEqual(["AFRM", "CAKE", "FXI"]);
    for (const one of ["NVDA", "nvidia", "#102", "bank of america", "home depot inc", "AFRM CAKE", "Goldman Sachs, the bank", ""]) expect(tickerList(one)).toBeNull();
    expect(tickerList(Array.from({ length: 60 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`).join(","))).toHaveLength(40);
  });

  it("lists each stock's cards: its own first, newest first; none when there are none", () => {
    const c = (id: number, primaryTicker: string, tickers: string[], createdAt: string): CardOnFile => ({ id, createdAt, status: "promoted", direction: "long", primaryTicker, tickers, title: `card ${id}` });
    const cards = [c(3, "ORCL", ["ORCL", "KGS"], "2026-11-20T00:00:00Z"), c(2, "KGS", ["KGS"], "2026-11-10T00:00:00Z"), c(1, "KGS", ["KGS"], "2026-10-01T00:00:00Z")];
    const by = cardsBySymbol(cards, ["KGS", "TSLA"]);
    expect(by.KGS.map((x) => [x.id, x.primary])).toEqual([[2, true], [1, true], [3, false]]);
    expect(by.TSLA).toEqual([]);
  });
});

describe("the query behind it (PGlite)", () => {
  it("runs against the real schema, and finds nothing in an empty database", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { setQuerierForTests } = await import("@/lib/db");
    const store = await import("@/lib/scout/store");
    const pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    try {
      expect(await store.cardsOnSymbols(["KGS", "ORCL"])).toEqual([]);
      expect(await store.cardsOnSymbols([])).toEqual([]);
    } finally {
      setQuerierForTests(null);
    }
  });
});
