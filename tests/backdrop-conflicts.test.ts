import { describe, expect, it } from "vitest";
import { AI_BASKET, backdropText, BUBBLE_NEWS, measureBackdrop } from "@/lib/scout/backdrop";
import { dropContradictions, openCalls, openCallsText } from "@/lib/scout/conflicts";
import type { Card } from "@/lib/scout/card";
import type { Track } from "@/lib/scout/store";

const series = (symbol: string, path: (i: number) => number, n = 100) => Array.from({ length: n }, (_, i) => ({ symbol, date: new Date(Date.UTC(2026, 6, 1) + i * 86400_000).toISOString().slice(0, 10), o: path(i), h: path(i), l: path(i), c: path(i), v: 1 }));

describe("AI-trade backdrop", () => {
  it("an unwinding AI basket: most names below the 50-day, far off highs, lagging SPY", () => {
    const bars = [...AI_BASKET.map((s) => series(s, (i) => (i < 70 ? 100 + i : 170 - (i - 70) * 2.5))), series("SPY", (i) => 500 + i * 0.1)].flat();
    const b = measureBackdrop(bars, "2026-11-21", { now: 14, before: 3 });
    expect(b.regime).toBe("unwinding");
    expect(b.below50).toBe(AI_BASKET.length);
    expect(b.medianOffHigh!).toBeLessThan(-20);
    const t = backdropText(b)!;
    expect(t).toContain("Regime: the AI trade is UNWINDING.");
    expect(t).toContain("14 in the last 7 days against 3 the week before");
    expect(t).toContain("A long on an AI-linked name needs a reason it would hold up");
  });

  it("an intact trade, and too little data says nothing", () => {
    const up = [...AI_BASKET.map((s) => series(s, (i) => 100 + i)), series("SPY", (i) => 500 + i * 0.1)].flat();
    expect(measureBackdrop(up, "2026-11-21").regime).toBe("intact");
    expect(backdropText(measureBackdrop([], "2026-11-21"))).toBeNull();
  });

  it("bubble headlines", () => {
    expect(BUBBLE_NEWS.test("Is the AI bubble about to burst?")).toBe(true);
    expect(BUBBLE_NEWS.test("AI stocks tumble as investors question spending")).toBe(true);
    expect(BUBBLE_NEWS.test("Chip stocks slump in AI sell-off")).toBe(true);
    expect(BUBBLE_NEWS.test("Hyperscalers signal capex digestion next year")).toBe(true);
    expect(BUBBLE_NEWS.test("Nvidia beats estimates")).toBe(false);
  });
});

describe("no related ticker against an open call", () => {
  const track = (cardId: number, symbol: string, direction: "long" | "short", over: Partial<Track> = {}): Track => ({ cardId, symbol, sectorEtf: "XLK", direction, cardDate: "2026-11-17", entryDate: null, entryPrice: null, spyEntry: null, sectorEntry: null, deadlineDate: "2026-12-30", exitDate: null, exitPrice: null, spyExit: null, sectorExit: null, exitReason: null, maxDrawdownPct: null, tappedAt: null, swingResponse: null, ...over });
  const calls = openCalls([track(212, "AAOI", "short"), track(279, "AAOI", "short"), track(125, "LITE", "long"), track(90, "FN", "short", { exitDate: "2026-11-10" })]);
  const card = { direction: "long", tickers: [{ symbol: "COHR" }, { symbol: "LITE" }, { symbol: "AAOI" }, { symbol: "FN" }] } as unknown as Card;

  it("drops AAOI from a long COHR card (open shorts #212, #279), keeps the rest", () => {
    const r = dropContradictions(card, calls);
    expect(r.card.tickers.map((t) => t.symbol)).toEqual(["COHR", "LITE", "FN"]);
    expect(r.notes).toEqual(["left out AAOI as a related ticker: the scout's open short calls #212, #279 on it point the other way"]);
  });

  it("never drops the card's own ticker, and tells research the open calls", () => {
    const own = { direction: "long", tickers: [{ symbol: "AAOI" }] } as unknown as Card;
    expect(dropContradictions(own, calls).card.tickers.map((t) => t.symbol)).toEqual(["AAOI"]);
    expect(openCallsText(calls)).toContain("AAOI short (#212, #279); LITE long (#125)");
    expect(openCallsText([])).toBeNull();
  });
});
