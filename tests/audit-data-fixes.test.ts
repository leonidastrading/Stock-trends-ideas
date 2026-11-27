import { describe, expect, it } from "vitest";
import { marketMatters, oddsMovers, ODDS_MIN_VOLUME } from "@/lib/market/panels";
import { cotReading, extremeLabel } from "@/lib/market/positioning";
import { crowdingScore, CROWDING_MIN_BASELINE_DAYS, type CrowdingParts } from "@/lib/scout/crowding";

describe("futures positioning says the side and the extreme apart", () => {
  it("net short at its least short in three years is not 'crowded long'", () => {
    expect(extremeLabel(-234_978, 96)).toBe("net short, least short in 3 years");
    expect(extremeLabel(120_000, 96)).toBe("net long, most long in 3 years");
    expect(extremeLabel(-300_000, 4)).toBe("net short, most short in 3 years");
    expect(extremeLabel(5_000, 4)).toBe("net long, least long in 3 years");
    expect(extremeLabel(-10_000, 50)).toBeNull();
    expect(extremeLabel(-10_000, null)).toBeNull();
  });

  it("'crowded' is said only when the side and the extreme agree", () => {
    const rows = (nets: number[]) => nets.map((net, i) => ({ report_date_as_yyyy_mm_dd: new Date(Date.UTC(2026, 0, 6 + i * 7)).toISOString().slice(0, 10), lev_money_positions_long: 100_000, lev_money_positions_short: 100_000 - net, open_interest_all: 2_000_000 }));
    // Always net short, and now the least short of 30 weeks.
    const lessShort = cotReading({ key: "es", name: "S&P 500 (e-mini)", ds: "tff" }, rows([...Array.from({ length: 29 }, (_, i) => -400_000 - i * 1000), -234_978]))!;
    expect([lessShort.crowd, lessShort.label]).toEqual([null, "net short, least short in 3 years"]);
    const veryLong = cotReading({ key: "es", name: "S&P 500 (e-mini)", ds: "tff" }, rows([...Array.from({ length: 29 }, (_, i) => 10_000 + i * 1000), 90_000]))!;
    expect([veryLong.crowd, veryLong.label]).toEqual(["crowded long", "net long, most long in 3 years"]);
  });
});

describe("prediction markets worth showing", () => {
  const m = (question: string, volume24hr: number) => ({ question, slug: question.toLowerCase().replace(/\W+/g, "-"), outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', oneDayPriceChange: 0.1, oneWeekPriceChange: 0.2, volume24hr });

  it("sport and show business are left out; so is a market with little money traded", () => {
    expect(marketMatters("Fed cuts rates in December?")).toBe(true);
    expect(marketMatters("Will Nvidia close above $150 on Friday?")).toBe(true);
    expect(marketMatters("Arsenal vs. Chelsea: who wins?")).toBe(false);
    expect(marketMatters("India to win the T20 cricket series?")).toBe(false);
    expect(marketMatters("Counter-Strike major: Team A to win?")).toBe(false);
    expect(marketMatters("Best Picture at the Oscars?")).toBe(false);
    const rows = oddsMovers([m("Fed cuts rates in December?", 900_000), m("Arsenal vs. Chelsea: who wins?", 5_000_000), m("Will Sony buy the studio?", 765), m("US tariffs on China above 60% by March?", ODDS_MIN_VOLUME)]);
    expect(rows.map((r) => r.question)).toEqual(["Fed cuts rates in December?", "US tariffs on China above 60% by March?"]);
  });
});

describe("crowding score", () => {
  it("leaves chatter out while the stock's own baseline is still building, and still gives a stage", () => {
    const parts = (days: number): CrowdingParts => ({ attention: { perHour: 6, baseline: days ? 2 : null, z: days ? 1.8 : null, days, bullishShare: null }, news: { stories30d: 12, baseline30d: 4, ratio: 2.8 }, run: { move30: 22, move90: 40, offHigh20: -2 } } as unknown as CrowdingParts);
    // Under 20 days the chatter reading is left out, and the stage comes from the other parts: a new stock still gets one.
    const thin = crowdingScore(parts(CROWDING_MIN_BASELINE_DAYS - 1)), full = crowdingScore(parts(CROWDING_MIN_BASELINE_DAYS));
    expect(thin).toMatchObject({ withoutChatter: true });
    expect(thin.stage).not.toBeNull();
    expect(thin.parts.attention).toBeUndefined();
    expect(thin.score).toBe(crowdingScore({ ...parts(0), attention: null }).score);
    expect(crowdingScore(parts(0)).stage).not.toBeNull();
    expect(full.parts.attention).toBeDefined();
    expect(full.withoutChatter).toBeUndefined();
  });
});
