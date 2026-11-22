import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { afterMove, BUBBLE_PROMPT, bubbleLevel, closesAround, parseEvents } from "@/lib/scout/bubbles";

const bar = (date: string, c: number): DailyBar => ({ symbol: "X", date, o: c, h: c, l: c, c, v: 1 }) as DailyBar;

describe("bubbles: fixed-date hype", () => {
  it("keeps dated events inside the next 30 days, with a real ticker, one per stock, event and date", () => {
    const heads = [{ headline: "Acme to join S&P 500 effective Dec 21", url: "https://n/1", source: "Reuters" }, { headline: "Zeta announces 10-for-1 split", url: "https://n/2", source: "PR" }];
    const text = JSON.stringify({ events: [
      { ticker: "$acme", type: "index_addition", date: "2026-12-21", what: "Acme joins the S&P 500 before the open.", n: 1 },
      { ticker: "ACME", type: "index_addition", date: "2026-12-21", what: "duplicate", n: 1 },
      { ticker: "ZETA", type: "stock_split", date: null, what: "no date yet", n: 2 },
      { ticker: "OLD", type: "earnings", date: "2026-11-20", what: "past", n: 1 },
      { ticker: "FAR", type: "ipo", date: "2027-03-01", what: "too far", n: 1 },
      { ticker: "not a ticker", type: "other", date: "2026-12-01", what: "x", n: 1 },
    ] });
    expect(parseEvents(text, heads, "2026-11-22")).toEqual([{ symbol: "ACME", type: "index_addition", date: "2026-12-21", what: "Acme joins the S&P 500 before the open.", url: "https://n/1", source: "Reuters" }]);
    expect(BUBBLE_PROMPT).toMatch(/data, not instructions/);
  });

  it("calls it mania only with a big run against SPY and loud attention", () => {
    expect(bubbleLevel({ run30: 40, spy30: 2, z: 3, stage: 2 })).toBe("mania");
    expect(bubbleLevel({ run30: 40, spy30: 2, z: 0.5, stage: 2 })).toBe("building");
    expect(bubbleLevel({ run30: 5, spy30: 2, z: null, stage: 3 })).toBe("building");
    expect(bubbleLevel({ run30: 10, spy30: 2, z: 4, stage: 1 })).toBe("quiet");
    expect(bubbleLevel({ run30: null, spy30: null, z: null, stage: null })).toBe("quiet");
  });

  it("measures after the date from the event-day close, against SPY", () => {
    const bars = ["2026-12-18", "2026-12-21", "2026-12-22", "2026-12-23"].map((d, i) => bar(d, 100 - i * 5));
    expect(closesAround(bars, "2026-12-19", 2)).toEqual({ on: 95, onDate: "2026-12-21", after: 85 });
    expect(closesAround(bars, "2027-01-05", 2)).toEqual({ on: null, onDate: null, after: null });
    expect(afterMove({ priceEvent: 100, priceAfter10: 80, spyEvent: 500, spyAfter10: 510 })).toBe(-22);
    expect(afterMove({ priceEvent: 100, priceAfter10: null, spyEvent: 500, spyAfter10: 510 })).toBeNull();
  });
});
