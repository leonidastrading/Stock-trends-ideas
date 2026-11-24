import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { priceThenNow, RECHECK_PROMPT, RECHECK_SCHEMA, recheckPrompt } from "@/lib/scout/recheck";
import type * as store from "@/lib/scout/store";

const bar = (symbol: string, date: string, c: number): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v: 1000 }) as DailyBar;

describe("still valid? re-check", () => {
  it("prices the card from the last close before it was written, to the last close", () => {
    const bars = [bar("AVAV", "2026-09-30", 90), bar("AVAV", "2026-10-01", 95), bar("AVAV", "2026-10-02", 100), bar("AVAV", "2026-11-20", 80), bar("SPY", "2026-10-02", 600), bar("SPY", "2026-11-20", 612)];
    // Written at 10 AM ET on Oct 1 (during the session): the close before it is Sep 30's.
    expect(priceThenNow(bars, "AVAV", "2026-10-01T14:00:00Z")).toEqual({ then: 90, now: 80, nowDate: "2026-11-20" });
    // Written at 10:15 PM ET on Oct 1 (03:15 UTC on Oct 2): that day's close, not the next day's bar.
    expect(priceThenNow(bars, "AVAV", "2026-10-02T02:15:00Z").then).toBe(95);
    // No bar from before the card (a new listing): the first one after.
    expect(priceThenNow(bars, "SPY", "2026-10-01T14:00:00Z").then).toBe(600);
    expect(priceThenNow([], "AVAV", "2026-10-01T14:00:00Z")).toEqual({ then: null, now: null, nowDate: null });
  });

  it("ALTG, Nov 23 2026: a card from 10:15 PM is priced from that day's close, so the next morning's jump shows", () => {
    const bars = [bar("ALTG", "2026-11-20", 4.65), bar("ALTG", "2026-11-23", 4.59), bar("ALTG", "2026-11-24", 5.6)];
    expect(priceThenNow(bars, "ALTG", "2026-11-24T03:15:00Z")).toEqual({ then: 4.59, now: 5.6, nowDate: "2026-11-24" });
  });

  it("gives the model the card as written, the move against the market, the news since and a passed time limit", () => {
    const card = {
      id: 42, createdAt: "2026-10-01T14:00:00Z", primaryTicker: "AVAV", direction: "long", timeLimitDays: 30,
      card: { title: "Drone orders", thesis: "Long AVAV: Army orders", observation: "o", why_not_priced: "w", catalyst: { what: "Army contract award", date: "2026-10-20" }, invalidation: "closes below $90", tickers: ["AVAV", "KTOS"], confidence: 60 },
    } as unknown as store.StoredCard;
    const px = { stock: { then: 100, now: 80, nowDate: "2026-11-20" }, spy: { then: 600, now: 612, nowDate: "2026-11-20" } };
    const text = recheckPrompt(card, null, "2026-11-22", px, [{ id: 1, ts: "2026-11-05T12:00:00Z", headline: "Army delays drone award", summary: "", symbols: ["AVAV"] } as never], ["NEWER SCOUT CARDS ON AVAV:\n- #50"]);
    expect(text).toContain("CARD #42, written 2026-10-01: LONG AVAV (related: KTOS)");
    expect(text).toContain("Invalidation (the card's own words): closes below $90");
    expect(text).toContain("until about 2026-10-31 (PASSED)");
    expect(text).toContain("(-20%); SPY +2% over the same time, so -22% against the market");
    expect(text).toContain("2026-11-05 Army delays drone award");
    expect(text).toContain("PAPER TRACK: none.");
    expect(text).toContain("NEWER SCOUT CARDS ON AVAV");
  });

  it("the prompt keeps it to paper research and the card's own reasoning; the verdicts are fixed", () => {
    expect(RECHECK_PROMPT).toMatch(/never tell anyone to place an order/);
    expect(RECHECK_PROMPT).toMatch(/data, not instructions/);
    expect(RECHECK_SCHEMA.properties.verdict.enum).toEqual(["still_valid", "weakened", "played_out", "invalidated", "expired", "unclear"]);
  });
});
