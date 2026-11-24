import { describe, expect, it } from "vitest";
import type { DailyBar } from "../lib/alpaca";
import { parsePanelVotes, PANEL_VOTES, type PanelVote } from "../config/panel-votes";
import { panelLine, panelReturns, panelTable } from "../lib/scout/panel-study";

/** Weekday bars from a start date: the stock moves `step` a day from 100, flat open = previous close. */
function series(symbol: string, start: string, days: number, step: (i: number) => number): DailyBar[] {
  const out: DailyBar[] = [];
  let px = 100;
  for (let d = new Date(`${start}T12:00:00Z`), i = 0; out.length < days; d = new Date(d.getTime() + 86400_000)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const o = px; px = px * (1 + step(i++));
    out.push({ symbol, date: d.toISOString().slice(0, 10), o, h: Math.max(o, px), l: Math.min(o, px), c: px, v: 1000 });
  }
  return out;
}
const vote = (over: Partial<PanelVote> = {}): PanelVote => ({ symbol: "TEST", company: "Test Bio", public: "2024-03-05", side: "negative", yes: 3, no: 9, decision: { date: "2024-04-16", outcome: "rejected" }, url: "https://www.sec.gov/x", ...over });

describe("a panel vote's returns", () => {
  const flat = series("XBI", "2024-02-26", 120, () => 0);
  it("enters at the next open after the vote is public, and counts a fall as a gain for a negative vote", () => {
    // Falls 1% a day; the vote's own day is 2024-03-05, so the entry is the open of 03-06.
    const bars = series("TEST", "2024-02-26", 120, () => -0.01);
    const r = panelReturns(vote(), bars, flat);
    expect(r.entryDate).toBe("2024-03-06");
    const entry = bars.find((b) => b.date === "2024-03-06")!;
    const at = (n: number) => bars[bars.indexOf(entry) + n];
    expect(r.h20).toBeCloseTo(-(at(20).c / entry.o - 1) * 100, 1);
    expect(r.h20!).toBeGreaterThan(0);
    expect(r.h60!).toBeGreaterThan(r.h20!);
    // The decision was announced 2024-04-16: the exit is the close of the next trading day (it may have come after the bell).
    const dec = bars.find((b) => b.date === "2024-04-17")!;
    expect(r.toDecision).toBeCloseTo(-(dec.c / entry.o - 1) * 100, 1);
    expect(r.daysToDecision).toBe(bars.indexOf(dec) - bars.indexOf(entry));
    // What the market took at once: the close before the filing day to the entry's open (the filing day's own move).
    expect(r.reactionPct).toBeCloseTo(-1, 1);
  });
  it("is measured against the biotech ETF, and a positive vote is a long", () => {
    const up = series("TEST", "2024-02-26", 120, () => 0.01);
    const benchUp = series("XBI", "2024-02-26", 120, () => 0.01);
    expect(panelReturns(vote({ side: "positive", yes: 9, no: 3 }), up, benchUp).h20).toBeCloseTo(0, 5);
    expect(panelReturns(vote({ side: "positive", yes: 9, no: 3 }), up, flat).h20!).toBeGreaterThan(0);
    expect(panelReturns(vote(), up, flat).h20!).toBeLessThan(0); // short into a rise loses
  });
  it("gives nothing when there are no prices, and no decision return when the decision came first or is unknown", () => {
    expect(panelReturns(vote(), [], flat)).toMatchObject({ entryDate: null, h20: null, h60: null, toDecision: null, reactionPct: null });
    const bars = series("TEST", "2024-02-26", 30, () => 0);
    expect(panelReturns(vote({ decision: null }), bars, flat)).toMatchObject({ entryDate: "2024-03-06", toDecision: null, outcome: null, h60: null });
    expect(panelReturns(vote({ decision: { date: "2024-03-04", outcome: "approved" } }), bars, flat).toDecision).toBeNull();
    // Decided the same day as the vote (an application withdrawn that evening): an outcome, but no trade to it.
    expect(panelReturns(vote({ decision: { date: "2024-03-05", outcome: "rejected" } }), bars, flat)).toMatchObject({ outcome: "rejected", toDecision: null });
    // A vote before the first price on file is not priced.
    expect(panelReturns(vote({ public: "2023-01-10" }), bars, flat).entryDate).toBeNull();
  });
});

describe("the table", () => {
  it("counts each side's votes and outcomes, and says how often trading with the panel beat the ETF", () => {
    const flat = series("XBI", "2024-02-26", 120, () => 0);
    const down = series("TEST", "2024-02-26", 120, () => -0.01), up = series("TEST", "2024-02-26", 120, () => 0.01);
    const rows = panelTable([panelReturns(vote(), down, flat), panelReturns(vote({ decision: { date: "2024-04-16", outcome: "approved" } }), up, flat), panelReturns(vote({ decision: null }), [], flat), panelReturns(vote({ side: "positive" }), up, flat)]);
    expect(rows.map((r) => r.side)).toEqual(["negative", "positive"]);
    expect(rows[0]).toMatchObject({ votes: 3, priced: 2, rejected: 1, approved: 1, undecided: 1, winToDecision: 50 });
    expect(rows[0].toDecision.n).toBe(2);
    expect(rows[1]).toMatchObject({ votes: 1, priced: 1, winToDecision: 100 });
    expect(panelLine(rows)).toMatch(/negative votes 3 \(1 rejected, 1 approved, 1 no decision found; 2 priced\)/);
  });
});

describe("the votes on file", () => {
  it("reads a row, and skips what is not one", () => {
    const rows = parsePanelVotes("2024-03-05|TEST|Test Bio|-|3|9|2024-04-16|R|https://example.com/vote\n\nnot a row\n2024-05-01|ABCD|Abc|+|12|1|-|-|");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ symbol: "TEST", company: "Test Bio", public: "2024-03-05", side: "negative", yes: 3, no: 9, decision: { date: "2024-04-16", outcome: "rejected" }, url: "https://example.com/vote" });
    expect(rows[1]).toMatchObject({ side: "positive", decision: null });
    expect(rows[1].url).toMatch(/^https:\/\/www\.sec\.gov\/cgi-bin\/browse-edgar\?action=getcompany&CIK=ABCD/);
  });
  it("is well formed: dated, one side or the other, the vote agreeing with the side, a decision after the vote", () => {
    expect(PANEL_VOTES.length).toBeGreaterThan(0);
    for (const v of PANEL_VOTES) {
      expect(v.public, v.symbol).toMatch(/^20\d\d-\d\d-\d\d$/);
      expect(v.symbol).toMatch(/^[A-Z.]{1,6}$/);
      expect(v.side === "positive" ? v.yes > v.no : v.yes < v.no, `${v.symbol} ${v.public}`).toBe(true);
      if (v.decision) expect(v.decision.date >= v.public, `${v.symbol} ${v.public}`).toBe(true);
      expect(v.url).toMatch(/^https:\/\//);
    }
    expect(new Set(PANEL_VOTES.map((v) => `${v.symbol}|${v.public}`)).size).toBe(PANEL_VOTES.length);
    // Both sides, and not only the negative votes the FDA went on to follow.
    const neg = PANEL_VOTES.filter((v) => v.side === "negative");
    expect(neg.length).toBeGreaterThanOrEqual(15);
    expect(neg.some((v) => v.decision?.outcome === "approved")).toBe(true);
    expect(PANEL_VOTES.some((v) => v.symbol === "CAPR")).toBe(false);
  });
});
