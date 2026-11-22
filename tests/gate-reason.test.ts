import { describe, expect, it } from "vitest";
import { gateReason } from "@/lib/scout/gate-reason";

describe("why a card was not promoted", () => {
  it("explains the deciding gate in plain words", () => {
    expect(gateReason("not_promoted", ["materiality: line is 1% of RTX revenue (gate: 10%)", "revenue share for RTX is the model's estimate"])).toBe("the business it is about is only about 1% of RTX's revenue, too small to move the stock (a card needs at least 10%)");
    expect(gateReason("not_promoted", ["ANT is not a listed symbol now; dropped", "no US price data for ANT (foreign or unlisted symbol?): not tracked"])).toMatch(/^ANT has no US price data/);
    expect(gateReason("not_promoted", ["no shorts under $5: $3.20 is under $5 (hard and costly to borrow, prone to squeezes)"])).toBe("a short on a $3.20 stock: under $5 is hard and costly to borrow, and prone to squeezes");
    expect(gateReason("not_promoted", ["short not promoted: up 62.0% in 30 days (limit 50%): squeeze risk; defined-risk puts or no trade"])).toBe("a short after a run-up: up 62.0% in 30 days (limit 50%): squeeze risk");
  });

  it("explains a late card, and says nothing for a promoted one", () => {
    expect(gateReason("late", ["39 mainstream stories in 30 days (gate: 20)"])).toBe("already widely covered: 39 mainstream stories in 30 days (the gate is 20)");
    expect(gateReason("late", ["stock up 34.0% in 30 days (gate: 25%)"])).toBe("the stock was already up 34.0% in 30 days (the gate is 25%)");
    expect(gateReason("promoted", ["materiality: line is 1% of RTX revenue (gate: 10%)"])).toBeNull();
  });
});
