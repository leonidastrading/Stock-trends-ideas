import { describe, expect, it } from "vitest";
import { fallbackThesis, thesisFor } from "@/lib/scout/thesis";
import type { StoredCard } from "@/lib/scout/store";

const card = (observation: string) => ({
  id: 211, createdAt: "2026-11-16T14:00:00Z", direction: "long", primaryTicker: "PANW",
  card: {
    title: "Palo Alto Networks bear market into fiscal Q1 earnings", observation, why_not_priced: "Valuation compression more than a miss.",
    catalyst: { what: "Palo Alto Networks fiscal Q1 2027 earnings and guidance", date: "unknown" }, time_limit_days: 30,
    tickers: [{ symbol: "PANW", company: "Palo Alto Networks" }],
  },
}) as unknown as StoredCard;

describe("one-sentence thesis", () => {
  it("uses the card's own 'The thesis:' sentence when there is one", () => {
    const t = fallbackThesis(card("PANW fell 26%. The thesis: the drawdown already prices in a lot of the valuation and integration fear. A clean print could produce a relief rally."));
    expect(t).toBe("Long PANW: the drawdown already prices in a lot of the valuation and integration fear. 30-day time limit.");
  });

  it("falls back to the title", () => {
    expect(fallbackThesis(card("PANW fell 26%."))).toBe("Long PANW: Palo Alto Networks bear market into fiscal Q1 earnings. 30-day time limit.");
    const dated = card("PANW fell 26%.");
    dated.card.catalyst = { what: "Q1 earnings and guidance, watch for restructuring charges and more words than fit", date: "2026-11-30" } as never;
    expect(fallbackThesis(dated)).toBe("Long PANW: Palo Alto Networks bear market into fiscal Q1 earnings. Catalyst about Nov 30, 2026; 30-day time limit.");
  });

  it("a card's own thesis always wins and never changes; older cards fall back", () => {
    const own = card("PANW fell 26%.");
    own.card.thesis = "Long PANW: the fears are priced in, so a clean report should lift it within 30 days.";
    expect(thesisFor(own, "a sentence written later")).toBe(own.card.thesis);
    expect(thesisFor(card("PANW fell 26%."), "written earlier for an old card")).toBe("written earlier for an old card");
    expect(thesisFor(card("PANW fell 26%."))).toMatch(/^Long PANW: /);
  });
});
