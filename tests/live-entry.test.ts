import { describe, expect, it } from "vitest";
import { liveEntry, sessionOpen } from "@/lib/scout/live-entry";

const cal = [{ date: "2026-11-23", open: "09:30", close: "16:00" }, { date: "2026-11-27", open: "09:30", close: "13:00" }];

describe("entry at the time of the card", () => {
  it("knows when the regular session is open (holidays and half days from the calendar)", () => {
    expect(sessionOpen(cal, "2026-11-23", 9 * 60 + 29)).toBe(false);
    expect(sessionOpen(cal, "2026-11-23", 9 * 60 + 30)).toBe(true);
    expect(sessionOpen(cal, "2026-11-23", 16 * 60)).toBe(false);
    expect(sessionOpen(cal, "2026-11-27", 13 * 60 + 5)).toBe(false); // half day after Thanksgiving
    expect(sessionOpen(cal, "2026-11-26", 11 * 60)).toBe(false); // Thanksgiving: no session
  });

  it("takes the live prices while open, nothing when closed or when the price is stale", async () => {
    const now = new Date("2026-11-23T16:00:00Z"); // 11:00 AM ET Monday
    const at = new Date(now.getTime() - 60_000).toISOString();
    const data = { getCalendar: async () => cal, getSnapshots: async () => ({ ABC: { price: 12.5, at }, SPY: { price: 600, at }, XLK: { price: 250, at: "2026-11-20T21:00:00Z" } }) } as never;
    expect(await liveEntry(data, ["ABC", "SPY", "XLK"], now)).toEqual({ ABC: 12.5, SPY: 600 });
    expect(await liveEntry(data, ["ABC", "SPY"], new Date("2026-11-23T22:00:00Z"))).toBeNull(); // 5 PM ET: next open
    expect(await liveEntry(data, ["XLK", "SPY"], now)).toBeNull(); // stale price for the stock itself
  });
});
