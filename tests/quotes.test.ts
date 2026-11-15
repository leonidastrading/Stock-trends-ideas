import { afterAll, describe, expect, it } from "vitest";
import { assertReadOnlyEndpoint, DATA_HOST, type MarketData } from "@/lib/alpaca";
import { quote, sessionLabel, setQuoteSourceForTests, toQuote } from "@/lib/market/quotes";

describe("card quotes", () => {
  afterAll(() => setQuoteSourceForTests(null));

  it("price and change vs the previous close, labelled by session", () => {
    const q = toQuote({ price: 161.01, prevClose: 164.35, at: "2026-11-13T20:59:59Z", sessionDate: "2026-11-13" });
    expect(q).toMatchObject({ price: 161.01, changePct: -2.03 });
    expect(sessionLabel(q, new Date("2026-11-15T17:00:00Z"))).toBe("Fri"); // the weekend shows Friday's move
    expect(sessionLabel(q, new Date("2026-11-13T18:00:00Z"))).toBe("today");
    expect(toQuote({ price: 5, prevClose: null, at: null, sessionDate: null }).changePct).toBeNull();
  });

  it("cards on one page share one snapshot call; a slow source shows no price instead of waiting", async () => {
    const calls: string[][] = [];
    setQuoteSourceForTests(() => ({ getSnapshots: async (s: readonly string[]) => { calls.push([...s]); return { AAON: { price: 95.2, prevClose: 94, at: null, sessionDate: "2026-11-13" }, PRE: { price: 3.1, prevClose: 3.2, at: null, sessionDate: "2026-11-13" } }; } }) as unknown as MarketData);
    const [a, b, c] = await Promise.all([quote("AAON"), quote("PRE"), quote("ZZZZ")]);
    expect(calls).toEqual([["AAON", "PRE", "ZZZZ"]]);
    expect([a?.changePct, b?.price, c]).toEqual([1.28, 3.1, null]);
    expect(await quote("AAON")).toMatchObject({ price: 95.2 }); // cached for a minute
    expect(calls).toHaveLength(1);

    setQuoteSourceForTests(() => ({ getSnapshots: () => new Promise(() => undefined) }) as unknown as MarketData);
    expect(await quote("NVDA", 50)).toBeNull();
  });

  it("snapshots are on the read-only list; orders are not", () => {
    expect(() => assertReadOnlyEndpoint(DATA_HOST, "/v2/stocks/snapshots")).not.toThrow();
    expect(() => assertReadOnlyEndpoint(DATA_HOST, "/v2/orders")).toThrow(/read-only/);
  });
});
