import { describe, expect, it } from "vitest";
import type { DailyBar, NewsItem } from "@/lib/alpaca";
import { classifyHeadline, driftContext, findDrifts, priceDrift } from "@/lib/scout/drift";
import { playerOf } from "@/lib/scout/scoreboard";

// 40 weekdays ending Friday 2026-11-13.
const DAYS: string[] = (() => {
  const out: string[] = [];
  const d = new Date("2026-11-13T12:00:00Z");
  while (out.length < 40) {
    if (d.getUTCDay() % 6 !== 0) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
})();
const series = (symbol: string, closes: number[], vol = 1_000_000, eventIdx = -1): DailyBar[] =>
  closes.map((c, i) => ({ symbol, date: DAYS[i], o: c, h: c * 1.01, l: c * 0.99, c, v: i === eventIdx ? vol * 5 : vol }));
const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);
const spy = series("SPY", flat(40, 500));
const news = (symbol: string, date: string, headline: string, hour = 13): NewsItem => ({ id: Math.random(), ts: `${date}T${String(hour).padStart(2, "0")}:00:00Z`, headline, summary: "", symbols: [symbol], source: "benzinga", url: `https://example.com/${symbol}/${date}` });

// Event on day 35 (2026-11-09): -12%; then 4 more days lower, small wiggle, no real bounce.
const drifter = series("ACME", [...flat(35, 50), 44, 43, 42.5, 41.8, 41.2], 1_000_000, 35);
const noNews = series("NONE", [...flat(35, 50), 44, 43, 42.5, 41.8, 41.2]);
const bounced = series("BNCE", [...flat(35, 50), 44, 42, 41, 43, 44]);
const tooCheap = series("PNNY", [...flat(35, 5), 4.4, 4.3, 4.25, 4.18, 4.12]);

describe("down drift: headlines", () => {
  it("names the bad event, counts pile-on, and ignores good news and lawsuit ads as events", () => {
    expect(classifyHeadline("Summit Therapeutics receives Complete Response Letter for ivonescimab").event).toBe("FDA / trial setback");
    expect(classifyHeadline("Acme cuts full-year guidance as demand slows").event).toBe("guidance cut");
    expect(classifyHeadline("Acme Q3 EPS misses estimates; revenue falls short").event).toBe("earnings miss");
    expect(classifyHeadline("Morgan Stanley downgrades Acme to Underweight").event).toBe("downgrade");
    expect(classifyHeadline("Acme prices $200 million public offering of common stock").event).toBe("dilution / offering");
    expect(classifyHeadline("Acme CFO resigns effective immediately").event).toBe("executive exit");
    expect(classifyHeadline("Hindenburg Research discloses short position in Acme").event).toBe("short report");
    expect(classifyHeadline("Acme shares are trading lower")).toEqual({ event: null, pileOn: true, lawsuitAd: false });
    expect(classifyHeadline("ROSEN, A LEADING LAW FIRM, Encourages Acme Investors to Secure Counsel - Class Action")).toEqual({ event: null, pileOn: true, lawsuitAd: true });
    expect(classifyHeadline("Goldman upgrades Acme to Buy")).toEqual({ event: null, pileOn: false, lawsuitAd: false });
    expect(classifyHeadline("Acme beats estimates, raises guidance").event).toBeNull();
  });
});

describe("down drift: detection", () => {
  const spyC = new Map(spy.map((b) => [b.date, b.c]));
  it("finds the drop and the drift after it from prices alone", () => {
    expect(priceDrift(drifter, spyC, DAYS[39])).toMatchObject({ d0: 35, daysAfter: 4 });
    expect(priceDrift(bounced, spyC, DAYS[39])).toBeNull(); // bounced off its low
    expect(priceDrift(tooCheap, spyC, DAYS[39])).toBeNull(); // under $5
  });

  it("needs news to explain the drop, and describes the setup", () => {
    const n = new Map([
      ["ACME", [news("ACME", "2026-11-09", "Acme cuts full-year guidance as demand slows"), news("ACME", "2026-11-10", "Acme shares slide for a second day"), news("ACME", "2026-11-11", "Morgan Stanley downgrades Acme to Underweight"), news("ACME", "2026-11-12", "Pomerantz Law Firm investigates claims on behalf of investors of Acme")]],
      ["NONE", [news("NONE", "2026-11-11", "None Corp shares are trading lower")]],
    ]);
    const s = findDrifts(new Map([["ACME", drifter], ["NONE", noNews], ["BNCE", bounced]]), spy, n);
    expect(s.map((x) => x.symbol)).toEqual(["ACME"]); // NONE: no event at the drop; BNCE: bounced
    expect(s[0]).toMatchObject({ eventDate: "2026-11-09", eventKind: "guidance cut", dayPct: -12, sincePct: -6.4, totalPct: -17.6, daysAfter: 4, downDays: 4, bouncePct: 0, volRatio: 5, badAfter: 2, lawsuitAds: 1, stage: "building", price: 41.2 });
    expect(s[0].headlines[0]).toMatchObject({ kind: "lawsuit ad" });
  });

  it("a bad-news 8-K counts as the event when there is no headline", () => {
    const s = findDrifts(new Map([["NONE", noNews]]), spy, new Map(), [{ symbol: "NONE", filed: "2026-11-06", items: ["4.02 non-reliance on past financial statements"] }]);
    expect(s[0]).toMatchObject({ symbol: "NONE", eventKind: "8-K: 4.02 non-reliance on past financial statements" });
  });

  it("research gets the numbers, the evidence and a short with a ~20-trading-day hold; cards score as their own player", () => {
    const [s] = findDrifts(new Map([["ACME", drifter]]), spy, new Map([["ACME", [news("ACME", "2026-11-09", "Acme cuts full-year guidance as demand slows")]]]));
    const c = driftContext(s);
    expect(c).toContain('on 2026-11-09 it fell -12% (-12% against SPY) on guidance cut news: "Acme cuts full-year guidance as demand slows"');
    expect(c).toMatch(/Chan 2003.*Hong, Lim & Stein.*Tetlock.*Frazzini/s);
    expect(c).toContain("Proposed: short ACME, held about 20 trading days (set the time limit near 28 days");
    expect(playerOf("scout", "drift: ACME guidance cut")).toBe("scout_drift");
  });
});
