import { describe, expect, it } from "vitest";
import { cardInvestigationText } from "../lib/scout/card-investigate";

describe("investigating from a card", () => {
  it("hands the investigation the card's own claims to check", () => {
    const t = cardInvestigationText({ id: 334, title: "Congo bans cobalt exports again", ticker: "ELBM", company: "Electra Battery Materials", direction: "long", thesis: "Long ELBM: the ban lifts cobalt prices.", observation: "Bloomberg reported the ban on Nov 22.", whyNotPriced: "Covered as a Congo story.", unknowns: ["cobalt price", "financing"] });
    expect(t).toMatch(/^Investigate the story behind the scout's card #334 \(\/cards\/334\): "Congo bans cobalt exports again"\./);
    expect(t).toContain("The card is long ELBM (Electra Battery Materials).");
    expect(t).toContain("Thesis: Long ELBM: the ban lifts cobalt prices.");
    expect(t).toContain("What the card could not check: cobalt price; financing");
    expect(t.length).toBeGreaterThan(80); // long enough that it is read as a story, not as a bare name
  });
  it("leaves out what the card does not have, and stays a sane length", () => {
    const t = cardInvestigationText({ id: 1, title: "T", ticker: "X", direction: "short", observation: "o".repeat(20_000) });
    expect(t).not.toContain("Thesis:");
    expect(t).not.toContain("could not check");
    expect(t.length).toBeLessThanOrEqual(6000);
  });
});
