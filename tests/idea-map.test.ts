import { describe, expect, it } from "vitest";
import { buildNodes, cardSource } from "@/lib/scout/idea-map";

describe("idea map", () => {
  it("names the source of a card from its research term", () => {
    expect(cardSource("scout", "story: NVDA CEO exit → NVDA")).toBe("story");
    expect(cardSource("scout", "insider+congress: MU")).toBe("congress");
    expect(cardSource("scout", "insider: STWD")).toBe("insider");
    expect(cardSource("scout", "filing: GSHD 8-K 4.02")).toBe("filings");
    expect(cardSource("scout", "truth: tariff on Mexico")).toBe("truth");
    expect(cardSource("human", "inbox: Short STRC")).toBe("inbox");
    expect(cardSource("human", "Prenetics IM8")).toBe("you");
    expect(cardSource("scout", "transformer shortage")).toBe("trend");
  });

  it("merges facts per stock, keeps the newest card, and puts multi-source stocks first", () => {
    const n = buildNodes([
      { symbol: "MU", source: "congress", note: "A bought" }, { symbol: "MU", source: "congress", note: "B bought" }, { symbol: "MU", source: "insider", note: "CEO bought $100k" },
      { symbol: "FRMI", source: "movers", note: "+26.7% today" }, { symbol: "FRMI", source: "stocktwits", note: "trending #11" }, { symbol: "FRMI", source: "you", note: "card #120" },
      { symbol: "ZZZ", source: "news", note: "lawsuit" }, { symbol: "bad sym", source: "news", note: "x" },
    ], [{ id: 120, symbol: "FRMI", direction: "short", status: "promoted", createdAt: "2026-11-14T23:00:00Z" }, { id: 90, symbol: "FRMI", direction: "long", status: "late", createdAt: "2026-11-01T00:00:00Z" }]);
    expect(n.map((x) => [x.symbol, x.links.length])).toEqual([["FRMI", 3], ["MU", 2], ["ZZZ", 1]]);
    expect(n[0]).toMatchObject({ cardId: 120, direction: "short" });
    expect(n[1].links.find((l) => l.source === "congress")!.note).toBe("A bought; B bought");
  });
});
