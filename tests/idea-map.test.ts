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

describe("map tooltips name the exact source", () => {
  it("document and idea for your bot, the story, the watch-list term, plus the research's evidence sources", async () => {
    const { cardNote } = await import("@/lib/scout/idea-map");
    const card = (id: number, conf = 54) => ({ id, direction: "long", status: "promoted", card: { confidence: conf, evidence: [{ source: "news" }, { source: "Stocktwits" }, { source: "news" }, { source: "edgar" }] } });
    expect(cardNote(card(124), "inbox", "inbox: KNX truckload rates", 'Rates up. (From the inbox document "2026-11-14-youtube"; an idea from Vadim\'s research bot.)'))
      .toBe('card #124 long (promoted), confidence 54 · from document "2026-11-14-youtube", idea "KNX truckload rates" · evidence: news, stocktwits, edgar');
    expect(cardNote(card(80), "story", "story: NVDA CEO exit → NVDA", null)).toMatch(/from story "NVDA CEO exit"/);
    expect(cardNote(card(7), "trend", "transformer shortage", null)).toMatch(/from watch-list \/ discovery term "transformer shortage"/);
    expect(cardNote(card(9), "you", "Prenetics IM8", "Seen at the gym.")).toMatch(/from your note "Seen at the gym\."/);
  });
});
