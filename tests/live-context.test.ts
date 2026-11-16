import { describe, expect, it } from "vitest";
import type { DailyBar, NewsItem } from "@/lib/alpaca";
import { liveContext, liveLines, tickersAsked } from "@/lib/scout/live-context";

const listed = new Set(["RDDT", "NVDA", "ON", "ALL", "NOW", "URGN", "CGON", "IT"]);

describe("live data for chat questions", () => {
  it("finds the stocks a typed question names, in any case, but not everyday words", () => {
    expect(tickersAsked("Why rddt keeps dropping", listed)).toEqual(["RDDT"]);
    expect(tickersAsked("what is going on with all of it now?", listed)).toEqual([]);
    expect(tickersAsked("Compare $NOW with NVDA and urgn", listed)).toEqual(["NOW", "NVDA", "URGN"]);
    expect(tickersAsked("IT spending is up", listed)).toEqual([]);
  });

  it("writes the price, moves and the week's headlines", () => {
    const bars: DailyBar[] = Array.from({ length: 70 }, (_, i) => ({ symbol: "URGN", date: `2026-${String(8 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, o: 40, h: 41, l: 39, c: 40 - i * 0.2, v: 1 }));
    const news: NewsItem[] = [{ id: 1, ts: "2026-11-16T14:05:00Z", headline: "CG Oncology Phase 3 PIVOT-006 meets primary endpoint", summary: "", symbols: ["CGON", "URGN"], source: "benzinga", url: "u" }];
    const t = liveLines("URGN", { price: 25.61, prevClose: 27.1, at: "2026-11-16T20:59:00Z" }, bars, news);
    expect(t).toMatch(/URGN price \$25\.61 \(−5\.5% vs the previous close\)/);
    expect(t).toMatch(/over 5 sessions/);
    expect(t).toMatch(/PIVOT-006 meets primary endpoint/);
  });

  it("asks the market data for quotes, bars and news", async () => {
    const data = {
      getSnapshots: async () => ({ RDDT: { price: 150, prevClose: 160, at: null, sessionDate: null } }),
      getDailyBars: async () => [] as DailyBar[],
      getNews: async () => [] as NewsItem[],
      getCalendar: async () => [],
    };
    const t = await liveContext(data as never, ["RDDT"], new Date("2026-11-16T16:00:00Z"));
    expect(t).toMatch(/^LIVE DATA fetched/);
    expect(t).toMatch(/RDDT price \$150\.00 \(−6\.3% vs the previous close\)/);
    expect(t).toMatch(/No headlines in the last 7 days/);
    expect(await liveContext(null, ["RDDT"])).toBeNull();
  });
});
