import { describe, expect, it } from "vitest";
import { repostedFrom } from "@/lib/alpaca";

// Monday Nov 16, 2026, 12:34 AM ET = 05:34Z.
const MON = "2026-11-16T05:34:00Z";

describe("re-posted news (Benzinga's \"Reported Sunday, …\")", () => {
  it("dates a re-post by the day it names", () => {
    expect(repostedFrom("Reported Sunday, Cocrystal Pharma Q3 EPS $(0.20) Misses $(0.18) Estimate", MON)).toBe("2026-11-15T17:00:00.000Z");
    expect(repostedFrom("Reported Saturday, Rocket Lab Completes 100th Electron Launch", MON)).toBe("2026-11-14T17:00:00.000Z");
    expect(repostedFrom("Reported Friday, Zai Lab Announces Five Medicines Included", MON)).toBe("2026-11-13T17:00:00.000Z");
  });

  it("never dates it after the re-post, and leaves ordinary headlines alone", () => {
    // "Reported Earlier" at 9:00 AM ET: noon would be later than the post, so the post time stands.
    expect(repostedFrom("Reported Earlier, Acme Raises Guidance", "2026-11-16T14:00:00Z")).toBe("2026-11-16T14:00:00.000Z");
    expect(repostedFrom("Acme Reported Sunday That Sales Rose", MON)).toBeNull();
    expect(repostedFrom("Zai Lab Announces Five Medicines", MON)).toBeNull();
  });
});
