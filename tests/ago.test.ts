import { describe, expect, it } from "vitest";
import { ago, dayAgo, fmtEtAgo } from "@/lib/time";

describe("how long ago", () => {
  const now = new Date("2026-11-19T21:30:00Z"); // 4:30 PM ET
  it("minutes under an hour, hours earlier today, then days by calendar day", () => {
    expect(ago("2026-11-19T21:29:40Z", now)).toBe("just now");
    expect(ago("2026-11-19T21:05:00Z", now)).toBe("25m ago");
    expect(ago("2026-11-19T12:00:00Z", now)).toBe("9h ago"); // 7 AM ET today
    expect(ago("2026-11-19T04:00:00Z", now)).toBe("1 day ago"); // 11 PM ET yesterday
    expect(ago("2026-11-16T19:01:00Z", now)).toBe("3 days ago");
    expect(ago("2026-11-19T21:50:00Z", now)).toBe("in 20m");
    expect(ago("2026-11-22T15:00:00Z", now)).toBe("in 3 days");
    expect(ago("nonsense", now)).toBe("");
  });
  it("calendar dates and the combined label", () => {
    expect(dayAgo("2026-11-19", now)).toBe("today");
    expect(dayAgo("2026-11-18", now)).toBe("1 day ago");
    expect(dayAgo("2027-02-17", now)).toBe("in 90 days");
    expect(fmtEtAgo("2026-11-16T19:01:00Z", now)).toBe("Nov 16, 2:01 PM ET · 3 days ago");
  });
});
