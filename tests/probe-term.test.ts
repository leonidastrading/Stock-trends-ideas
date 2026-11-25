import { describe, expect, it } from "vitest";
import type { DailyBar } from "../lib/alpaca";
import { trailingMoves } from "../lib/scout/price-check";
import { isBareTicker, searchName } from "../lib/scout/probe-term";

describe("a bare ticker is searched by the company's name (card #409: 'TXN' measured TX Network)", () => {
  it("knows a term that is only the stock's ticker", () => {
    expect(isBareTicker("TXN", ["TXN"])).toBe(true);
    expect(isBareTicker("$txn", ["TXN", "ADI"])).toBe(true);
    expect(isBareTicker("BRK.B", ["BRK.B"])).toBe(true);
    // A word that is not one of the idea's tickers, a topic, or a desk label is searched as typed.
    expect(isBareTicker("AI", ["NVDA"])).toBe(false);
    expect(isBareTicker("data center power demand", ["VRT"])).toBe(false);
    expect(isBareTicker("story: ASH → ASH", ["ASH"])).toBe(false);
    expect(isBareTicker("TXN", [])).toBe(false);
  });
  it("turns a listing's name into what people search for", () => {
    expect(searchName("Texas Instruments Incorporated Common Stock")).toBe("Texas Instruments");
    expect(searchName("Plexus Corp. Common Stock")).toBe("Plexus");
    expect(searchName("Redwire Corporation")).toBe("Redwire");
    expect(searchName("Alphabet Inc. Class A Common Stock")).toBe("Alphabet");
    expect(searchName("Global Payments Inc.")).toBe("Global Payments");
    expect(searchName("The Cheesecake Factory Incorporated")).toBe("Cheesecake Factory");
    expect(searchName("Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share")).toBe("Alibaba");
    expect(searchName("Ashland Inc.")).toBe("Ashland");
  });
});

describe("the price history research is given", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 7, 1) + i * 86400_000).toISOString().slice(0, 10);
  const bars = (symbol: string, px: (i: number) => number): DailyBar[] => Array.from({ length: 117 }, (_, i) => ({ symbol, date: day(i), o: px(i), h: px(i) * 1.01, l: px(i) * 0.99, c: px(i), v: 1 }));
  const today = day(116);

  it("says how far the stock has moved over a week, a month and a quarter, against SPY", () => {
    // Flat at 300, then a slide over the last 30 days to 251.
    const txn = bars("TXN", (i) => (i < 86 ? 300 : 300 - (i - 86) * (49 / 30)));
    const spy = bars("SPY", () => 600);
    const line = trailingMoves("TXN", [...txn, ...spy], today)!;
    expect(line).toMatch(/^PRICE HISTORY/);
    expect(line).toMatch(/-16\.3% over 30 days \(SPY 0%\)/);
    expect(line).toMatch(/-16\.3% over 90 days/);
    expect(line).toMatch(/over 7 days/);
    expect(line).toMatch(/from its high of the last 117 sessions/);
    expect(line).toMatch(/Do not list the recent price moves as unknown/);
  });
  it("gives nothing without enough prices, and leaves out a span it cannot measure", () => {
    expect(trailingMoves("TXN", [], today)).toBeNull();
    expect(trailingMoves("NEW", bars("NEW", () => 10).slice(-3), today)).toBeNull();
    const young = trailingMoves("IPO", bars("IPO", () => 20).slice(-20), today)!;
    expect(young).toMatch(/over 7 days/);
    expect(young).not.toMatch(/over 90 days/);
  });
});
