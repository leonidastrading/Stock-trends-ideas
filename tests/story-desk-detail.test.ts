import { describe, expect, it } from "vitest";
import { isFollowupDetail, isStoriesDetail } from "../components/desk/StoryDesk";

describe("the Home page reads only real desk reports", () => {
  it("a daily pass's note in place of a step is not a report (it crashed Home on Nov 24 2026)", () => {
    for (const note of ["later: no time left in this pass", "done in an earlier pass", null, undefined, { error: "boom" }, 3]) {
      expect(isStoriesDetail(note)).toBe(false);
      expect(isFollowupDetail(note)).toBe(false);
    }
    expect(isStoriesDetail({ headlinesRead: 10, detected: [], triage: [], researched: [], error: null })).toBe(true);
    expect(isFollowupDetail({ checked: [], researched: [], skipped: [], error: null })).toBe(true);
  });
});
