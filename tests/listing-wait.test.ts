import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { gateNow, waitingForListing } from "@/lib/scout/listing-wait";
import type * as store from "@/lib/scout/store";

const ant = { status: "not_promoted", createdAt: "2026-11-15T00:07:00Z", timeLimitDays: 120, gateNotes: ["ANT is not a listed symbol now; dropped", "39 mainstream stories in 30 days (gate: 20)", "no US price data for ANT (foreign or unlisted symbol?): not tracked"] } as unknown as store.StoredCard;
const bar = (date: string, c: number): DailyBar => ({ symbol: "ANT", date, o: c, h: c, l: c, c, v: 1 }) as DailyBar;

describe("cards waiting for their stock to list", () => {
  it("waits only for cards that were not followed because the symbol did not trade, inside the time limit and 60 days", () => {
    expect(waitingForListing(ant, "2026-11-22")).toBe(true);
    expect(waitingForListing(ant, "2027-01-20")).toBe(false); // past the 60-day wait
    expect(waitingForListing({ ...ant, timeLimitDays: 5 }, "2026-11-22")).toBe(false); // past its own time limit
    expect(waitingForListing({ ...ant, status: "late" }, "2026-11-22")).toBe(false);
    expect(waitingForListing({ ...ant, gateNotes: ["materiality: line is 3% of X revenue (gate: 10%)"] }, "2026-11-22")).toBe(false);
  });

  it("runs the gates it skipped: materiality, and for shorts the $5 floor and the run-up limit", () => {
    const card = (share: number | null, direction: "long" | "short" = "short") => ({ direction, card: { tickers: [{ symbol: "ANT", revenue_share_pct: share }] } }) as unknown as store.StoredCard;
    expect(gateNow(card(100), [bar("2026-11-19", 95), bar("2026-11-20", 88.48)])).toBeNull();
    expect(gateNow(card(5), [bar("2026-11-19", 95)])).toMatch(/materiality/);
    expect(gateNow(card(100), [bar("2026-11-19", 4.5)])).toMatch(/under \$5/);
    expect(gateNow(card(100), [bar("2026-11-19", 50), bar("2026-11-20", 90)])).toMatch(/up 80\.0% since listing/);
    expect(gateNow(card(100, "long"), [bar("2026-11-19", 50), bar("2026-11-20", 90)])).toBeNull();
  });
});
