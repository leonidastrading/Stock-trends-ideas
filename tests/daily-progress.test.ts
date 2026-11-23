import { describe, expect, it } from "vitest";
import { dailyProgress } from "../lib/scout/engine";

describe("the daily job's passes", () => {
  it("needs another pass while terms are unmeasured or a step is not done", () => {
    expect(dailyProgress([], 12)).toEqual({ done: [], more: true });
    expect(dailyProgress(["discovery", "stories"], 0)).toEqual({ done: ["discovery", "stories"], more: true });
    expect(dailyProgress(["followups", "stories", "discovery"], 4).more).toBe(true);
  });
  it("is finished when everything is measured and every step ran", () => {
    expect(dailyProgress(["followups", "stories", "discovery", "junk"], 0)).toEqual({ done: ["discovery", "stories", "followups"], more: false });
  });
});
