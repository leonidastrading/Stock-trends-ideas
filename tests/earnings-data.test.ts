import { describe, expect, it } from "vitest";
import { finnhubDates } from "@/lib/sources/earnings-data";
describe("Finnhub report dates (foreign companies)", () => {
  it("keeps this stock's past report dates, sorted, once each", () => {
    const j = { earningsCalendar: [{ symbol: "PDD", date: "2026-11-19" }, { symbol: "PDD", date: "2026-08-25" }, { symbol: "PDD", date: "2026-11-19" }, { symbol: "BABA", date: "2026-11-18" }, { symbol: "PDD", date: "2027-03-20" }, { symbol: "PDD", date: "" }] };
    expect(finnhubDates(j, "PDD", "2026-11-22")).toEqual(["2026-08-25", "2026-11-19"]);
  });
});
