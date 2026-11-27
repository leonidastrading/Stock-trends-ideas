import { describe, expect, it } from "vitest";
import { splitBySymbol } from "@/components/CardChips";

const b = (id: number, primaryTicker: string, tickers: string[], createdAt: string) => ({ id, createdAt, status: "promoted", direction: "long" as const, primaryTicker, tickers });

describe("cards on a stock", () => {
  it("puts the cards written about the stock apart from the ones that only name it", () => {
    const cards = [b(155, "LMT", ["LMT", "RTX"], "2026-11-14T15:00:00Z"), b(313, "RTX", ["RTX"], "2026-11-22T15:00:00Z"), b(286, "NOC", ["NOC", "RTX", "LMT"], "2026-11-20T15:00:00Z"), b(198, "RTX", ["RTX", "LMT"], "2026-11-16T15:00:00Z")];
    const { direct, related } = splitBySymbol(cards, "rtx");
    expect(direct.map((c) => c.id)).toEqual([313, 198]);
    expect(related.map((c) => c.id)).toEqual([286, 155]);
    expect(splitBySymbol(cards, null).direct).toHaveLength(4); // no stock given: all listed as before
  });
});
