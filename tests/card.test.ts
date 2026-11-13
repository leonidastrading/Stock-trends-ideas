import { describe, expect, it } from "vitest";
import { applyGates, CARD_JSON_SCHEMA, catalystDate, NoEvidenceError, parseCard, rankScore, type Card } from "@/lib/scout/card";

export const sampleCard = (p: Partial<Card> = {}): Card => ({
  title: "Transformer backlog pulls forward grid capex",
  kind: "second_order",
  origin: "scout",
  observation: "EDGAR filings mentioning transformer shortages rose from 3/month to 11 in the last 30 days (as of 2026-11-10).",
  evidence: [
    { source: "edgar", metric: "filings_30d", value: "11", change_vs_12m: "+260%", as_of: "2026-11-10" },
    { source: "hacker_news", metric: "stories_7d", value: "9", change_vs_12m: "+120%", as_of: "2026-11-10" },
  ],
  tickers: [
    { symbol: "HUBB", why: "grid components", revenue_share_pct: 35, share_is_estimate: true, sector: "industrials" },
    { symbol: "ETN", why: "electrical segment", revenue_share_pct: 20, share_is_estimate: true, sector: "industrials" },
  ],
  why_not_priced: "Analysts model flat utility capex.",
  lateness: { news_stories_30d: 4, stock_move_30d_pct: 3, stock_move_90d_pct: 8, already_obvious: false },
  catalyst: { what: "Q4 results", date: "2027-01-28" },
  direction: "long",
  invalidation: "Backlog commentary turns down in the next 10-Q.",
  time_limit_days: 90,
  scores: { novelty: 7, materiality: 8, breadth_of_evidence: 6, lateness: 8 },
  confidence: 62,
  unknowns: ["exact order intake"],
  ...p,
});

describe("card parsing", () => {
  it("accepts a valid card and rejects bad JSON or schema", () => {
    expect(parseCard(JSON.stringify(sampleCard())).title).toMatch(/Transformer/);
    expect(() => parseCard("not json")).toThrow(/valid JSON/);
    expect(() => parseCard(JSON.stringify({ ...sampleCard(), tickers: [] }))).toThrow(/tickers/);
    expect(() => parseCard(JSON.stringify({ ...sampleCard(), time_limit_days: 400 }))).toThrow(/time_limit_days/);
  });
  it("uppercases symbols and reads the catalyst date", () => {
    const c = parseCard(JSON.stringify(sampleCard({ tickers: [{ symbol: "hubb", why: "x", revenue_share_pct: 50, share_is_estimate: false, sector: "industrials" }] })));
    expect(c.tickers[0].symbol).toBe("HUBB");
    expect(catalystDate(c)).toBe("2027-01-28");
    expect(catalystDate(sampleCard({ catalyst: { what: "x", date: "unknown" } }))).toBeNull();
    expect(rankScore(c)).toBe(56);
  });
});

describe("gates", () => {
  const measured = { newsStories30d: 4, stockMove30dPct: 5, stockMove90dPct: 12 };
  it("promotes a material, early idea and replaces lateness with measured numbers", () => {
    const g = applyGates(sampleCard(), measured);
    expect(g.status).toBe("promoted");
    expect(g.card.lateness).toEqual({ news_stories_30d: 4, stock_move_30d_pct: 5, stock_move_90d_pct: 12, already_obvious: false });
    expect(g.notes.join()).toMatch(/model's estimate/);
  });
  it("no evidence, no card; items without a date are dropped", () => {
    expect(() => applyGates(sampleCard({ evidence: [] }), measured)).toThrow(NoEvidenceError);
    expect(() => applyGates(sampleCard({ evidence: [{ source: "x", metric: "m", value: "1", change_vs_12m: "", as_of: "yesterday" }] }), measured)).toThrow(NoEvidenceError);
    const g = applyGates(sampleCard({ evidence: [...sampleCard().evidence, { source: "", metric: "m", value: "1", change_vs_12m: "", as_of: "2026-01-01" }] }), measured);
    expect(g.card.evidence).toHaveLength(2);
    expect(g.notes[0]).toMatch(/dropped/);
  });
  it("materiality: under 10% or no estimate is logged but not promoted", () => {
    const t = sampleCard().tickers[0];
    expect(applyGates(sampleCard({ tickers: [{ ...t, revenue_share_pct: 4 }] }), measured).status).toBe("not_promoted");
    expect(applyGates(sampleCard({ tickers: [{ ...t, revenue_share_pct: null }] }), measured).status).toBe("not_promoted");
    expect(applyGates(sampleCard({ tickers: [{ ...t, revenue_share_pct: 10 }] }), measured).status).toBe("promoted");
  });
  it("lateness: measured 30-day move over 30% or over 20 mainstream stories marks the idea late", () => {
    expect(applyGates(sampleCard(), { ...measured, stockMove30dPct: 31 }).status).toBe("late");
    expect(applyGates(sampleCard(), { ...measured, newsStories30d: 21 }).status).toBe("late");
    expect(applyGates(sampleCard(), { ...measured, stockMove30dPct: 30 }).status).toBe("promoted");
    const g = applyGates(sampleCard({ lateness: { ...sampleCard().lateness, already_obvious: true } }), measured);
    expect(g.status).toBe("late");
    expect(g.notes.join()).toMatch(/model itself/);
  });
  it("materiality is checked before lateness; the model's own numbers are kept when nothing was measured", () => {
    const t = sampleCard().tickers[0];
    const g = applyGates(sampleCard({ tickers: [{ ...t, revenue_share_pct: 2 }] }), { ...measured, stockMove30dPct: 50 });
    expect(g.status).toBe("not_promoted");
    const u = applyGates(sampleCard(), { newsStories30d: null, stockMove30dPct: null, stockMove90dPct: null });
    expect(u.card.lateness.stock_move_30d_pct).toBe(3);
    expect(u.notes.join()).toMatch(/not measured/);
  });
});

describe("reply schema", () => {
  it("uses only keywords structured outputs accept", () => {
    const banned = /"(minItems|maxItems|minimum|maximum|pattern|minLength|maxLength|format)":/;
    expect(JSON.stringify(CARD_JSON_SCHEMA)).not.toMatch(banned);
  });
});

describe("whole-company story trades", () => {
  it("a missing revenue share means 100% for a story trade, so the card is tracked as late rather than dropped", () => {
    const t = sampleCard().tickers[0];
    const card = sampleCard({ kind: "event", direction: "short", tickers: [{ ...t, symbol: "NVDA", revenue_share_pct: null, sector: "technology" }] });
    const measured = { newsStories30d: 288, stockMove30dPct: -8, stockMove90dPct: 5 };
    expect(applyGates(card, measured).status).toBe("not_promoted");
    const g = applyGates(card, measured, { wholeCompany: true });
    expect(g.status).toBe("late");
    expect(g.card.tickers[0]).toMatchObject({ revenue_share_pct: 100, share_is_estimate: false });
    expect(g.notes.join()).toMatch(/whole-company/);
  });
});
