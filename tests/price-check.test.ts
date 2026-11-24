import { describe, expect, it } from "vitest";
import type { DailyBar, MinuteBar } from "@/lib/alpaca";
import { priceCheck, priceCheckText } from "@/lib/scout/price-check";

const day = (date: string, c: number): DailyBar => ({ symbol: "ALTG", date, o: c, h: c, l: c, c, v: 1000 }) as DailyBar;
const min = (t: string, c: number): MinuteBar => ({ t, o: c, h: c, l: c, c, v: 100 });

describe("the price check at research time", () => {
  const daily = [day("2026-11-20", 4.65), day("2026-11-23", 4.59)];

  it("ALTG, Nov 23 2026: a card at 10:15 PM sees the after-hours jump on the 4 PM news", () => {
    const now = new Date("2026-11-24T03:15:00Z"); // 10:15 PM ET
    const minute = [min("2026-11-23T20:55:00Z", 4.59), min("2026-11-23T21:05:00Z", 5.9), min("2026-11-23T22:30:00Z", 4.95), min("2026-11-24T00:40:00Z", 5.2)];
    const p = priceCheck("ALTG", daily, minute, now)!;
    expect(p).toMatchObject({ close: 4.59, closeDate: "2026-11-23", dayPct: -1.3, inSession: false, ext: { price: 5.2, pct: 13.3, trades: 3 } });
    const text = priceCheckText(p, now);
    expect(text).toMatch(/^PRICE CHECK \(measured by the scout's code now; not a source\): ALTG closed at \$4\.59 on 2026-11-23 \(-1\.3% on the day\)\. Since that close it has traded at \$5\.20 \(\+13\.3% against the close\) as of 7:40 PM ET, in after-hours trading/);
    expect(text).toContain("the market already reacting");
    expect(text).toContain("do not call the news overlooked");
  });

  it("before the open the next morning it is the pre-market price", () => {
    const now = new Date("2026-11-24T13:00:00Z"); // 8 AM ET
    const p = priceCheck("ALTG", daily, [min("2026-11-24T00:40:00Z", 5.2), min("2026-11-24T12:45:00Z", 4.8)], now)!;
    expect(p.ext).toMatchObject({ price: 4.8, pct: 4.6 });
    expect(priceCheckText(p, now)).toContain("as of 7:45 AM ET, in pre-market trading");
    expect(priceCheckText(p, now)).toContain("There is no large move so far.");
  });

  it("during the session it is the day's move so far, with no extended-hours line", () => {
    const now = new Date("2026-11-24T16:34:00Z"); // 11:34 AM ET
    const p = priceCheck("ALTG", [...daily, day("2026-11-24", 5.63)], [min("2026-11-24T00:40:00Z", 5.2)], now)!;
    expect(p).toMatchObject({ inSession: true, close: 5.63, dayPct: 22.7, ext: null });
    expect(priceCheckText(p, now)).toMatch(/ALTG is trading at \$5\.63, \+22\.7% today so far/);
    expect(priceCheckText(p, now)).toContain("the market already reacting");
  });

  it("a quiet stock says so, and no prices means no check", () => {
    const now = new Date("2026-11-24T03:15:00Z");
    expect(priceCheckText(priceCheck("ALTG", daily, [], now)!, now)).toMatch(/No trade after that close was seen\. There is no large move so far\./);
    expect(priceCheck("ALTG", [], [], now)).toBeNull();
  });
});
