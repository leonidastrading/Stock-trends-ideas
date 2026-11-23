import { describe, expect, it } from "vitest";
import { downgradeInfo } from "@/lib/scout/drift";
import { playerOf } from "@/lib/scout/scoreboard";

describe("downgrade drift", () => {
  it("reads the broker, the rating change and how strong it is", () => {
    expect(downgradeInfo("Goldman Sachs Downgrades Acceleration Holdings to Neutral")).toEqual({ broker: "Goldman Sachs", from: null, to: "Neutral", strength: "mild", topBroker: true });
    expect(downgradeInfo("William Blair Downgrades USA Rare Earth to Market Perform")).toMatchObject({ broker: "William Blair", to: "Market Perform", strength: "mild", topBroker: false });
    expect(downgradeInfo("Jefferies downgrades Acme from Buy to Underperform")).toMatchObject({ from: "Buy", to: "Underperform", strength: "strong", topBroker: true });
    expect(downgradeInfo("Acme shares slide after weak quarter")).toBeNull();
  });

  it("downgrade cards score apart from the other down-drift cards", () => {
    expect(playerOf("scout", "drift: ACCV downgrade")).toBe("scout_downgrade");
    expect(playerOf("scout", "drift: HIMS executive exit")).toBe("scout_drift");
  });
});
