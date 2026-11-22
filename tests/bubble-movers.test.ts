import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { hypeLevel, parabola, themeState } from "@/lib/scout/bubble-movers";
import { moverOutcome } from "@/lib/scout/bubble-run";
import { parseHype } from "@/lib/scout/bubbles";

/** 120 sessions of a quiet stock wobbling about 1% a day, then `tail` closes. */
function path(tail: number[], v = 1000, tailVol = 1000): DailyBar[] {
  const out: DailyBar[] = [];
  let p = 10;
  const d0 = Date.UTC(2026, 4, 1);
  for (let i = 0; i < 120; i++) { p *= i % 2 ? 1.01 : 0.99; out.push({ symbol: "X", date: new Date(d0 + i * 86400000).toISOString().slice(0, 10), o: p, h: p, l: p, c: p, v } as DailyBar); }
  tail.forEach((c, i) => out.push({ symbol: "X", date: new Date(d0 + (120 + i) * 86400000).toISOString().slice(0, 10), o: c, h: c, l: c, c, v: tailVol } as DailyBar));
  return out;
}

describe("bubbles: parabolic on hype", () => {
  it("measures a speeding-up run in standard deviations of the stock's own normal moves", () => {
    const base = 10 * 0.99 ** 60 * 1.01 ** 60;
    const run = Array.from({ length: 21 }, (_, i) => base * (1 + 0.004 * i + (i > 11 ? 0.05 * (i - 11) : 0)));
    const p = parabola(path(run, 1000, 5000))!;
    expect(p.run30).toBeGreaterThan(50);
    expect(p.sigmas30).toBeGreaterThan(5);
    expect(p.accel).toBeGreaterThan(0.5);
    expect(p.volRatio).toBeGreaterThan(3);
    expect(hypeLevel(p, { z: null, stage: null })).toBe("mania");
    expect(hypeLevel({ ...p, volRatio: 1 }, { z: null, stage: null })).toBe("building"); // no loud attention: not mania
    expect(hypeLevel({ ...p, volRatio: 1 }, { z: 3, stage: null })).toBe("mania");
    expect(parabola(path([]).slice(0, 40))).toBeNull();
  });

  it("a quiet stock is quiet; a falling one is never a bubble", () => {
    expect(hypeLevel(parabola(path([]))!, { z: 5, stage: 4 })).toBe("quiet");
    const fall = parabola(path(Array.from({ length: 21 }, (_, i) => 10 * (1 - 0.03 * i))))!;
    expect(fall.run30).toBeLessThan(0);
    expect(hypeLevel(fall, { z: 5, stage: 4 })).toBe("quiet");
  });

  it("a theme is hot when most of its members are, mania with two in mania", () => {
    expect(themeState([{ symbol: "A", level: "mania", run30: 80 }, { symbol: "B", level: "mania", run30: 60 }, { symbol: "C", level: "quiet", run30: 5 }])).toEqual({ hot: 2, median30: 60, level: "mania" });
    expect(themeState([{ symbol: "A", level: "building", run30: 30 }, { symbol: "B", level: "quiet", run30: 2 }, { symbol: "C", level: "quiet", run30: 1 }, { symbol: "D", level: "quiet", run30: 0 }]).level).toBe("quiet");
  });

  it("reads the news's hype stories, and scores how runs ended against SPY", () => {
    const text = JSON.stringify({ events: [], hype: [{ theme: "Quantum computing", tickers: ["$ionq", "RGTI", "bad ticker"], why: "Frenzy after a chip claim.", n: 1 }, { theme: "", tickers: ["X"], why: "", n: 2 }] });
    expect(parseHype(text, [{ headline: "Quantum stocks soar", url: "https://n/1", source: "CNBC" }])).toEqual([{ theme: "Quantum computing", tickers: ["IONQ", "RGTI"], why: "Frenzy after a chip claim.", url: "https://n/1", source: "CNBC" }]);
    expect(moverOutcome({ priceFirst: 100, spyFirst: 500 }, 70, 510)).toBe(-32);
    expect(moverOutcome({ priceFirst: 100, spyFirst: 500 }, null, 510)).toBeNull();
  });
});
