import { describe, expect, it } from "vitest";
import { dueSlot } from "@/lib/scout/st-trending";

describe("Stocktwits trending ten: 9 AM and 3 PM ET", () => {
  it("takes each slot once, and a late first run takes only the later slot", () => {
    expect(dueSlot(8 * 60 + 59, new Set())).toBeNull();
    expect(dueSlot(9 * 60 + 5, new Set())).toBe("am");
    expect(dueSlot(9 * 60 + 5, new Set(["am"]))).toBeNull();
    expect(dueSlot(15 * 60 + 2, new Set(["am"]))).toBe("pm");
    expect(dueSlot(15 * 60 + 2, new Set())).toBe("pm");
    expect(dueSlot(18 * 60, new Set(["am", "pm"]))).toBeNull();
  });
});
