import { describe, expect, it } from "vitest";
import { agree, entryVerdict, inRange, jumped, splitFactorSince, splitWords } from "@/lib/scout/price-sanity";

const bar = (date: string, l: number, h: number, c: number) => ({ symbol: "X", date, o: c, h, l, c, v: 1000 });

describe("splits since a paper entry", () => {
  it("measures the split from the same day's close as traded and as adjusted today", () => {
    expect(splitFactorSince(809.11, 101.14)).toBeCloseTo(0.125, 3); // SanDisk, 8-for-1
    expect(splitFactorSince(1.5, 15)).toBe(10); // 1-for-10 reverse split
    expect(splitFactorSince(50, 50.4)).toBe(1); // a rounding difference is not a split
    expect(splitWords(0.125)).toBe("8-for-1");
    expect(splitWords(10)).toBe("1-for-10");
    expect(splitWords(1 / 1.5)).toBe("1.5-for-1");
  });

  it("puts an entry recorded before the split on today's prices (SanDisk card #89)", () => {
    const raw = bar("2026-11-16", 790, 840, 809.11), adj = bar("2026-11-16", 98.75, 105, 101.14);
    const v = entryVerdict(826.87, raw, adj);
    expect(v).toMatchObject({ kind: "ok", asTraded: true });
    expect(v?.kind === "ok" && v.factor).toBeCloseTo(0.125, 3);
    // $826.87 x 0.125 = $103.36: against $73.61 that is -29%, not the -92% the raw entry showed.
    expect(826.87 * (v as { factor: number }).factor).toBeCloseTo(103.36, 1);
  });

  it("leaves an entry alone when there was no split, or when it was recorded after the split", () => {
    expect(entryVerdict(1.39, bar("2026-11-23", 1.15, 1.41, 1.17), bar("2026-11-23", 1.15, 1.41, 1.17))).toEqual({ kind: "ok", factor: 1, asTraded: true }); // OPAL: a real fall
    expect(entryVerdict(103, bar("2026-11-16", 790, 840, 809.11), bar("2026-11-16", 98.75, 105, 101.14))).toEqual({ kind: "ok", factor: 1, asTraded: false });
  });

  it("measures a closed call on its exit day's prices", () => {
    // Entered before an 8-for-1 split and closed after it: the exit price is already on the new prices.
    const v = entryVerdict(826.87, bar("2026-11-16", 790, 840, 809.11), bar("2026-11-16", 98.75, 105, 101.14), 1);
    expect(v?.kind === "ok" && v.factor).toBeCloseTo(0.125, 3);
    // Entered and closed before the split: both on the old prices, nothing to adjust.
    const both = entryVerdict(826.87, bar("2026-11-16", 790, 840, 809.11), bar("2026-11-16", 98.75, 105, 101.14), 0.125);
    expect(both?.kind === "ok" && both.factor).toBeCloseTo(1, 3);
  });

  it("marks an entry outside the day's traded range as unverified", () => {
    const v = entryVerdict(60, bar("2026-11-16", 98, 105, 101), bar("2026-11-16", 98, 105, 101));
    expect(v?.kind).toBe("unverified");
    expect(v?.kind === "unverified" && v.note).toContain("outside the range the stock traded in on 2026-11-16 ($98 to $105)");
    expect(entryVerdict(100, undefined, undefined)).toBeNull(); // no bar that day: nothing to check against
  });

  it("allows a little slack for a different feed, and flags a 40% daily move for a second look", () => {
    expect(inRange(106, { l: 98, h: 105 })).toBe(true);
    expect(inRange(112, { l: 98, h: 105 })).toBe(false);
    expect(jumped(1.17, 0.7792)).toBe(false); // -33%: large, not flagged
    expect(jumped(755.16, 79.24)).toBe(true); // an unadjusted split looks like -90%
    expect(agree(79.24, 79.3)).toBe(true);
    expect(agree(79.24, 755)).toBe(false);
  });
});
