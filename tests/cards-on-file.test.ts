import { describe, expect, it } from "vitest";
import { cardsBySymbol, typedTickers, type CardOnFile } from "../lib/scout/cards-on-file";

describe("existing cards shown while a ticker is typed", () => {
  it("reads the tickers out of what was typed", () => {
    expect(typedTickers("orcl, $crwv  KGS")).toEqual(["ORCL", "CRWV", "KGS"]);
    expect(typedTickers("kgs kgs BRK.B toolongname 123")).toEqual(["KGS", "BRK.B"]);
    expect(typedTickers("a b c d e f g")).toHaveLength(5);
    expect(typedTickers("  ")).toEqual([]);
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
