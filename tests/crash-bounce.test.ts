import { describe, expect, it } from "vitest";
import { findCrashBounce, type Bar } from "@/lib/market/crash-bounce";

/** Weekday dates from 2025-01-02. */
function days(n: number): string[] {
  const out: string[] = [];
  for (let d = new Date("2025-01-02T12:00:00Z"); out.length < n; d = new Date(d.getTime() + 86400000)) if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  return out;
}
/** Bars from [open, high, low, close] rows, 1M shares a day. */
const make = (rows: Array<[number, number, number, number]>): Bar[] => { const ds = days(rows.length); return rows.map((r, i) => [ds[i], ...r, 1_000_000] as Bar); };

// 220 quiet days near $4, a run-up to a $25 peak (6x the low), a crash to $12, a bounce to the 50% level, then the fade.
function story(after: Array<[number, number, number, number]>) {
  const rows: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 220; i++) rows.push([4.2, 4.4, 4, 4.2]);
  for (let i = 1; i <= 20; i++) { const p = 4 + i; rows.push([p - 0.5, p + 0.2, p - 0.8, p]); } // up to 24
  rows.push([24, 25, 23.5, 24.6]);    // peak: high 25, close within 20%
  rows.push([22, 22.5, 18, 18.5]);
  rows.push([17, 17.5, 13, 13.5]);    // -48%: crash confirmed (low 13)
  rows.push([13.5, 14, 12, 12.8]);    // lower low: first low 12
  rows.push([13, 15, 12.6, 14.8]);
  rows.push([15, 19, 17.5, 18.6]);    // high 19 >= 12 + (25-12)/2 = 18.5: trigger, its low 17.5
  return [...rows, ...after];
}

describe("crash-and-bounce short setup", () => {
  it("finds the peak, the first low and the trigger, then shorts the break and covers at the target", () => {
    const bars = make(story([
      [18.4, 18.9, 17.8, 18.2],   // no break of 17.5: the level moves up to 17.8
      [18, 18.3, 16.9, 17.0],     // breaks 17.8: short at 17.8 (opened above it)
      [16.5, 16.8, 14, 14.5],
      [14, 14.2, 10.5, 10.9],     // below the target 12 x 0.9 = 10.8: covered there
    ]));
    const [s, ...rest] = findCrashBounce(bars);
    expect(rest).toHaveLength(0);
    expect(s.peak).toMatchObject({ price: 25, closeOk: true });
    expect(s.peak.runUp).toBeGreaterThanOrEqual(5);
    expect(s.firstLow).toMatchObject({ price: 12, dropPct: 52 });
    expect(s.level).toBe(18.5);
    expect(s.trigger?.price).toBe(19);
    expect(s.entry).toEqual({ date: bars[bars.length - 3][0], price: 17.8 });
    expect(s.stop).toBe(19.01);           // just above the highest high from the trigger to the entry
    expect(s.target).toBe(10.8);
    expect(s.exit).toMatchObject({ reason: "target", price: 10.8 });
    expect(s.returnPct).toBeCloseTo(39.3, 1);
    expect(s.status).toBe("closed");
    expect(s.filters.ok).toBe(true);
  });

  it("stops out above the highest high since the trigger, and a gap up fills at the open", () => {
    const bars = make(story([[18, 18.2, 17.0, 17.2], [20, 21, 19.5, 20.5]]));
    const s = findCrashBounce(bars)[0];
    expect(s.entry?.price).toBe(17.5);
    expect(s.exit).toMatchObject({ reason: "stop", price: 20 }); // stop 19.01, opened at 20
    expect(s.returnPct).toBeCloseTo(-14.3, 1);
  });

  it("is cancelled by a trade above the peak, and waits while nothing has happened yet", () => {
    expect(findCrashBounce(make(story([[19, 26, 18.8, 25.5]])))[0]).toMatchObject({ status: "cancelled", entry: null });
    const waiting = findCrashBounce(make(story([[18.4, 18.9, 17.8, 18.2]])))[0];
    expect(waiting).toMatchObject({ status: "waiting for entry", entryLevel: 17.8 });
  });

  it("applies the filters: actual price under $10, thin volume, a wick peak", () => {
    const bars = make(story([]));
    const raw = new Map(bars.map((b) => [b[0], { c: b[4] / 10, v: b[5] * 10 }])); // a 1-for-10 reverse split since: real price $1.86
    const s = findCrashBounce(bars, raw)[0];
    expect(s.filters.ok).toBe(false);
    expect(s.filters.why[0]).toMatch(/actual price \$1\.86 is under \$10/);
    const thin = make(story([])).map((b) => [b[0], b[1], b[2], b[3], b[4], 1000] as Bar);
    expect(findCrashBounce(thin)[0].filters.why.join(" ")).toMatch(/average daily volume \$0\.0M/);
  });

  it("needs a 5x run-up: a stock that only doubled has no setup", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 220; i++) rows.push([12, 12.4, 12, 12.2]);
    rows.push([20, 25, 19, 24.5], [20, 21, 13, 13.5], [14, 19, 13.5, 18.8]);
    expect(findCrashBounce(make(rows))).toEqual([]);
  });
});
