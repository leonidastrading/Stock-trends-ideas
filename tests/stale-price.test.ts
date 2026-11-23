import { describe, expect, it } from "vitest";
import { applyLatestBars, staleSymbols, type Snapshot } from "@/lib/alpaca";

const snap = (price: number, at: string | null): Snapshot => ({ price, at, prevClose: null, sessionDate: null });

describe("stale IEX prices", () => {
  it("flags symbols with no IEX trade for 20+ minutes during the session only", () => {
    const s = { PROF: snap(6.58, "2026-11-20T20:59:00Z"), AAPL: snap(230, "2026-11-23T15:20:00Z") };
    expect(staleSymbols(s, new Date("2026-11-23T15:24:00Z"))).toEqual(["PROF"]); // Monday 10:24 AM ET
    expect(staleSymbols(s, new Date("2026-11-23T14:00:00Z"))).toEqual([]); // 9:00 AM ET, before the open
    expect(staleSymbols(s, new Date("2026-11-22T15:24:00Z"))).toEqual([]); // Sunday
  });

  it("takes the latest whole-market bar when it is newer than the IEX trade", () => {
    const s: Record<string, Snapshot> = { PROF: snap(6.58, "2026-11-20T20:59:00Z"), OLD: snap(10, "2026-11-23T15:10:00Z") };
    applyLatestBars(s, { PROF: [{ t: "2026-11-23T15:05:00Z", c: 6.41 }, { t: "2026-11-23T15:07:00Z", c: 6.4 }], OLD: [{ t: "2026-11-23T15:00:00Z", c: 9 }] });
    expect(s.PROF).toMatchObject({ price: 6.4, at: "2026-11-23T15:07:00Z", delayed: true });
    expect(s.OLD.price).toBe(10); // the IEX trade was newer
  });
});
