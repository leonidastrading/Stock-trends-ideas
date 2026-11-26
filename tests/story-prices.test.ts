import { describe, expect, it } from "vitest";
import type { DailyBar, MarketData, MinuteBar } from "@/lib/alpaca";
import { moveLine, movesLine, priceCheck } from "@/lib/scout/price-check";
import { buildStoryPrompt, STORY_SYSTEM_PROMPT, storySymbols, type Story } from "@/lib/scout/stories";

const bar = (symbol: string, date: string, c: number): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v: 1000 });
const daily = [bar("SNY", "2026-11-20", 47.1), bar("SNY", "2026-11-23", 46.9), bar("SPY", "2026-11-20", 700), bar("SPY", "2026-11-23", 702.1)];
const pre: MinuteBar[] = [{ t: "2026-11-24T13:55:00Z", o: 50.6, h: 50.9, l: 50.5, c: 50.8, v: 900 }];

describe("what a story's stocks have already done", () => {
  it("says the day's move and the pre-market move in a few words", () => {
    const now = new Date("2026-11-24T14:10:00Z"); // 9:10 AM ET, before the open
    expect(moveLine(priceCheck("SNY", daily, pre, now)!)).toBe("SNY -0.4% on 2026-11-23 (close $46.90), then +8.3% in pre-market trading to $50.80");
    const open = new Date("2026-11-23T16:00:00Z"); // 11 AM ET, in the session
    expect(moveLine(priceCheck("SNY", daily, [], open)!)).toBe("SNY -0.4% today so far, at $46.90");
  });

  it("one line for the story's stocks and SPY; nothing when prices are missing", async () => {
    const data = { getDailyBars: async (syms: readonly string[]) => daily.filter((b) => syms.includes(b.symbol)), getMinuteBars: async (sym: string) => (sym === "SNY" ? pre : []) } as unknown as MarketData;
    expect(await movesLine(data, ["SNY", "NOPE", "SPY"], new Date("2026-11-24T14:10:00Z"))).toBe("SNY -0.4% on 2026-11-23 (close $46.90), then +8.3% in pre-market trading to $50.80; SPY +0.3% on 2026-11-23 (close $702.10)");
    expect(await movesLine(null, ["SNY"], new Date())).toBeNull();
    expect(await movesLine({ getDailyBars: async () => { throw new Error("down"); } } as unknown as MarketData, ["SNY"], new Date())).toBeNull();
  });

  it("the story's stocks include the buyer its headlines name, not only the stock the story is filed under", () => {
    const h = (symbols: string[]) => ({ at: "2026-11-24T08:31:00Z", source: "x", headline: "Sanofi to Acquire Insmed for $41 Billion", url: "", symbols });
    expect(storySymbols({ symbols: ["INSM"], headlines: [h(["SNY", "INSM"]), h(["INSM"]), h(["SNY", "INSM", "sanofi sa"])] })).toEqual(["INSM", "SNY"]);
    expect(storySymbols({ symbols: [], headlines: [h(["A", "B", "C", "D", "E"])] })).toHaveLength(4);
  });

  it("the desk is shown the prices and told not to trade against the first move on a rule of thumb", () => {
    const story = { key: "INSM", symbols: ["INSM"], stories: 3, mainstream: 2, shockHits: 0, escalationHits: 0, escalation: [], headlines: [], prices: "SNY -0.4% on 2026-11-23 (close $46.90), then +8.3% in pre-market trading to $50.80" } as unknown as Story;
    expect(buildStoryPrompt([story], "2026-11-24")).toContain("Prices (measured by the scout's code just now, 15 minutes delayed; not a source): SNY -0.4% on 2026-11-23 (close $46.90), then +8.3% in pre-market trading to $50.80.");
    expect(STORY_SYSTEM_PROMPT).toContain('Do not name a trade against it on a rule of thumb ("buyers dip", "good news fades")');
    expect(STORY_SYSTEM_PROMPT).toContain("When the buyer RISES on its own deal, the market is endorsing it");
  });
});
