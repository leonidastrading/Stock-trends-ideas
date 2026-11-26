import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { axisTicks, cardPdf, cardPdfName, pdfSafe, shortMoney, wrapText, type CardPdfInput } from "@/lib/scout/card-pdf";
import type { StoredCard, Track } from "@/lib/scout/store";

const card = {
  id: 377, versionId: 41, createdAt: "2026-11-24T14:10:00Z", origin: "scout", kind: "event", title: "Sanofi agrees to buy Insmed for $41 billion; its own shares may drift lower", model: "m", modelServed: null, costUsd: 0.2,
  status: "late", gateNotes: ["late: stock already moved 8% → priced"], primaryTicker: "SNY", sector: "health_care", direction: "short", timeLimitDays: 30, catalystDate: "2026-12-15", rankScore: 42,
  card: {
    title: "Sanofi agrees to buy Insmed for $41 billion; its own shares may drift lower", thesis: "Short SNY: paying $41 billion, roughly a third of Sanofi's market value, likely needs new debt, so Sanofi shares may lag the market over 30 days as financing details emerge.",
    kind: "event", origin: "scout",
    observation: "Sanofi agreed on Nov 24 to acquire Insmed for about $41 billion in cash — roughly a third of its own market value. The price is ≥ 26% above Insmed's close before the first report (Nov 19). Financing has not been detailed → new debt is likely. “Buyers usually dip” after deals this size.",
    evidence: [
      { source: "fiscal.ai", metric: "Deal value", value: "$41 billion", change_vs_12m: "n/a", as_of: "2026-11-24" },
      { source: "SEC EDGAR (8-K, Insmed)", metric: "Merger agreement filed", value: "yes", change_vs_12m: "n/a", as_of: "2026-11-24" },
      { source: "Stocktwits", metric: "Message volume on SNY", value: "3.1× the 30-day average, mostly bullish ✓", change_vs_12m: "+210%", as_of: "2026-11-24" },
    ],
    tickers: [{ symbol: "SNY", company: "Sanofi", why: "The buyer: it pays about a third of its market value and takes on the financing.", revenue_share_pct: null, share_is_estimate: false, sector: "health_care" }, { symbol: "INSM", company: "Insmed", why: "The target trades near the offer; nothing left to earn.", revenue_share_pct: 100, share_is_estimate: true, sector: "health_care" }],
    why_not_priced: "The first reaction focuses on the pipeline gain; the cost of financing a deal this size tends to weigh on the buyer over the following weeks.",
    lateness: { news_stories_30d: 14, stock_move_30d_pct: 4.2, stock_move_90d_pct: -3.5, already_obvious: true },
    catalyst: { what: "Financing terms and any rating-agency comment", date: "2026-12-15" }, direction: "short",
    invalidation: "Sanofi funds the deal mostly from cash on hand, or the stock closes above its pre-deal high for three sessions.",
    time_limit_days: 30, scores: { novelty: 4, materiality: 7, breadth_of_evidence: 6, lateness: 3 }, confidence: 48,
    expression: "Shares; the move, if it comes, should be slow.", unknowns: ["how the deal is financed", "whether a rival bidder appears"],
  },
} as unknown as StoredCard;
const track = { cardId: 377, symbol: "SNY", sectorEtf: "XLV", direction: "short", cardDate: "2026-11-24", entryDate: "2026-11-24", entryPrice: 50.3, spyEntry: 700, sectorEntry: 150, deadlineDate: "2026-12-24", exitDate: null, exitPrice: null, spyExit: null, sectorExit: null, exitReason: null, maxDrawdownPct: -8, tappedAt: null, swingResponse: null } as unknown as Track;
const closes = Array.from({ length: 178 }, (_, i) => (i < 168 ? 44 + 4 * Math.sin(i / 9) + i * 0.02 : i < 176 ? 47 - (i - 168) * 0.1 : i === 176 ? 51.9 : 54.39));
const bars = closes.map((c, i) => { const o = i ? closes[i - 1] + (i % 3 - 1) * 0.3 : c; return { date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), c, o, h: Math.max(o, c) + 0.6, l: Math.min(o, c) - 0.5, v: 1e6 * (1 + (i % 7) / 3) + (i > 175 ? 6e6 : 0) }; });
const fundamentals = {
  period: "quarter" as const, source: "SEC filings (XBRL) and Finnhub",
  income: [["Q2 '25", 8.1e6, -52e6], ["Q3 '25", 7.9e6, -54e6], ["Q1 '26", 6.5e6, -61e6], ["Q2 '26", 5.2e6, -67e6], ["Q3 '26", 4.0e6, -83.1e6]].map(([label, revenue, netIncome], i) => ({ label: label as string, date: `2026-0${i + 1}-30`, revenue: revenue as number, netIncome: netIncome as number, margin: Math.round(((netIncome as number) / (revenue as number)) * 1000) / 10 })),
  eps: [["Q1 '26", -1.06, -0.51], ["Q2 '26", -0.52, null], ["Q3 '26", -0.68, -0.56]].map(([label, actual, estimate], i) => ({ label: label as string, date: `2026-0${i + 4}-15`, actual: actual as number, estimate: estimate as number | null })),
};
const input: CardPdfInput = { card, track, review: null, about: "Sanofi is a French multinational pharmaceutical company that makes prescription medicines and vaccines.", sectorLabel: "Health care", companyName: "Sanofi", source: "News scan", bars, fundamentals, result: { ret: -0.081, spy: 0.004, vsSpy: -0.077, closed: false }, siteUrl: "https://example.com", now: new Date("2026-11-26T01:55:00Z") };

describe("a card as a PDF", () => {
  it("swaps or drops what the PDF's fonts cannot draw, and wraps to the width", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(pdfSafe("up 8% → priced; ≥ 26%; 3.1× the average ✓ 📈 日本", font)).toBe("up 8% -> priced; >= 26%; 3.1x the average yes");
    expect(pdfSafe("“Buyers usually dip” — a rule of thumb…", font)).toBe("“Buyers usually dip” — a rule of thumb…");
    const lines = wrapText("one two three four five six seven eight nine ten", font, 10, 80);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => font.widthOfTextAtSize(l, 10) <= 80)).toBe(true);
    expect(lines.join(" ")).toBe("one two three four five six seven eight nine ten");
    // A word longer than a line is cut, not lost.
    expect(wrapText("https://example.com/a-very-long-address-that-does-not-fit", font, 10, 80).join("")).toBe("https://example.com/a-very-long-address-that-does-not-fit");
  });

  it("short amounts and round axis values for the financial charts", () => {
    expect([shortMoney(11e6), shortMoney(-83.1e6), shortMoney(4e6), shortMoney(1.25e9), shortMoney(0), shortMoney(null), shortMoney(350_000)]).toEqual(["11M", "-83M", "4.0M", "1.3B", "0", "-", "350K"]);
    expect(axisTicks(-83e6, 8e6)).toEqual([-100e6, -50e6, 0, 50e6]);
    expect(axisTicks(-1.06, 0)).toEqual([-1.5, -1, -0.5, 0]);
  });

  it("is a real PDF with the card in it, with or without prices and a paper track", async () => {
    const pdf = await cardPdf(input);
    if (process.env.CARD_PDF_OUT) writeFileSync(process.env.CARD_PDF_OUT, Buffer.from(pdf));
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getPageCount()).toBeLessThanOrEqual(3);
    expect(doc.getTitle()).toBe("Card #377: Sanofi agrees to buy Insmed for $41 billion; its own shares may drift lower");
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    const bare = await cardPdf({ ...input, track: null, bars: [], fundamentals: null, result: null, about: null, companyName: null, source: null, siteUrl: null });
    // Closes only (no open, high or low on file): the chart falls back to a line.
    expect((await PDFDocument.load(await cardPdf({ ...input, bars: bars.map((b) => ({ date: b.date, c: b.c })) }))).getPageCount()).toBeGreaterThanOrEqual(1);
    expect((await PDFDocument.load(bare)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(cardPdfName(card)).toBe("card-377-SNY-short.pdf");
  });

  it("a very long card runs onto more pages instead of off the page", async () => {
    const long = { ...card, card: { ...card.card, observation: Array.from({ length: 60 }, () => card.card.observation).join(" "), evidence: Array.from({ length: 40 }, () => card.card.evidence[2]) } } as StoredCard;
    expect((await PDFDocument.load(await cardPdf({ ...input, card: long }))).getPageCount()).toBeGreaterThan(2);
  });
});
