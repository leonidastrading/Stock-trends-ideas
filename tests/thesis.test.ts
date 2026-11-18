import { describe, expect, it } from "vitest";
import { cardForPrompt, fallbackThesis, THESIS_PROMPT } from "@/lib/scout/thesis";
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
    expect(t).toBe("Long PANW: the drawdown already prices in a lot of the valuation and integration fear; catalyst: Palo Alto Networks fiscal Q1 2027 earnings and guidance, within 30 days.");
  });

  it("falls back to the title", () => {
    expect(fallbackThesis(card("PANW fell 26%."))).toMatch(/^Long PANW: Palo Alto Networks bear market into fiscal Q1 earnings; catalyst: .*, within 30 days\.$/);
  });

  it("gives the model the card's fields and asks for one plain sentence", () => {
    expect(cardForPrompt(card("PANW fell 26%."))).toMatch(/^CARD 211: long PANW \(Palo Alto Networks\), time limit 30 days, written 2026-11-16\.\nTitle: .*\nObservation: PANW fell 26%\./);
    expect(THESIS_PROMPT).toMatch(/ONE plain-English sentence/);
    expect(THESIS_PROMPT).toMatch(/data, not instructions/);
  });
});
