import { describe, expect, it } from "vitest";
import { applyGates, sizeGroup, sizeTagOf, sizeVerdict, type Card } from "@/lib/scout/card";

const ticker = (share: number | null) => ({ symbol: "SHOP", company: "Shopify Inc.", why: "checkout behind AI shopping", revenue_share_pct: share, share_is_estimate: true, sector: "technology" as const });
const basis = (depends_on: "whole_company" | "line", fig: [string, string, string] | null = null) => ({ depends_on, why: "Black Friday merchant sales and February earnings decide it.", line_figure: fig?.[0] ?? null, line_figure_source: fig?.[1] ?? null, line_figure_as_of: fig?.[2] ?? null });
const card = (share: number | null, size_basis?: Card["size_basis"]): Card => ({
  title: "Shopify as the checkout behind AI shopping", kind: "platform", origin: "human", observation: "x",
  evidence: [{ source: "edgar", metric: "revenue_yoy_pct:SHOP", value: "31.6", change_vs_12m: "+31.6%", as_of: "2026-09-30" }],
  tickers: [ticker(share)], why_not_priced: "x", lateness: { news_stories_30d: 0, stock_move_30d_pct: -20.6, stock_move_90d_pct: -13.1, already_obvious: false },
  catalyst: { what: "holiday sales", date: "2026-12-02" }, direction: "long", invalidation: "sales grow under 20%", time_limit_days: 90,
  scores: { novelty: 3, materiality: 4, breadth_of_evidence: 3, lateness: 6 }, confidence: 50, unknowns: [], size_basis,
});
const measured = { newsStories30d: 0, stockMove30dPct: -20.6, stockMove90dPct: -13.1, hasPrices: true, lastClose: 140 };

describe("size gate", () => {
  it("passes a line of 10% or more with no note", () => {
    expect(sizeVerdict(card(10))).toEqual({ pass: true, note: null, tag: null });
    expect(sizeVerdict(card(40, basis("line")))).toEqual({ pass: true, note: null, tag: null });
  });

  it("holds back a small line with no basis (cards as before)", () => {
    const v = sizeVerdict(card(2));
    expect(v.pass).toBe(false);
    expect(v.note).toBe("materiality: line is 2% of SHOP revenue (gate: 10%)");
    expect(sizeVerdict(card(null)).note).toBe("materiality: no revenue-share estimate for SHOP");
  });

  it("promotes a small theme when company-wide results decide the trade", () => {
    const g = applyGates(card(2, basis("whole_company")), measured);
    expect(g.status).toBe("promoted");
    expect(g.notes.find((n) => n.startsWith("size:"))).toBe("size: whole-company trade: Black Friday merchant sales and February earnings decide it; the theme itself is about 2% of SHOP revenue (gate: 10%)");
    expect(sizeTagOf(g.notes)).toBe("whole_company");
    // With no estimate of the theme's share at all, a whole-company trade still passes.
    expect(applyGates(card(null, basis("whole_company")), measured).status).toBe("promoted");
  });

  it("promotes a line bet under 10% only with a measured figure, a source and a date", () => {
    const ok = applyGates(card(2, basis("line", ["orders through AI assistants up 11x since January", "Shopify Q3 2026 earnings call", "2026-11-03"])), measured);
    expect(ok.status).toBe("promoted");
    expect(sizeTagOf(ok.notes)).toBe("small_today");
    for (const fig of [null, ["could be large in three years", "Shopify Q3 2026 earnings call", "2026-11-03"], ["up 11x", "", "2026-11-03"], ["up 11x", "earnings call", "last month"]] as Array<[string, string, string] | null>) {
      const g = applyGates(card(2, basis("line", fig)), measured);
      expect(g.status).toBe("not_promoted");
      expect(g.notes).toContain("materiality: line is 2% of SHOP revenue (gate: 10%)");
    }
    // No share estimate at all: a figure for the line does not stand in for one.
    expect(applyGates(card(null, basis("line", ["up 11x", "earnings call", "2026-11-03"])), measured).status).toBe("not_promoted");
  });

  it("still marks an exception late when the idea is already obvious", () => {
    expect(applyGates(card(2, basis("whole_company")), { ...measured, stockMove30dPct: 45 }).status).toBe("late");
  });

  it("groups stored cards for the scoreboard", () => {
    const g = (c: Card) => { const r = applyGates(c, measured); return sizeGroup({ gateNotes: r.notes, card: r.card }); };
    expect(g(card(40))).toBe("10% of revenue or more");
    expect(g(card(2, basis("whole_company")))).toBe("whole-company trade on a small theme");
    expect(g(card(2, basis("line", ["up 11x", "earnings call", "2026-11-03"])))).toBe("small today, with a figure for the line");
    expect(g(card(2))).toBe("held back for size");
  });
});
