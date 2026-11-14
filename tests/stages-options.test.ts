import { describe, expect, it } from "vitest";
import type { DailyBar, NewsItem } from "@/lib/alpaca";
import { assertReadOnlyEndpoint, DATA_HOST } from "@/lib/alpaca";
import { storiesSeen } from "@/lib/scout/followup";
import { atmIv, describe as describeOptions, parseOcc, realizedVol } from "@/lib/scout/options";
import { attachHistory, buildStoryPrompt, detectStories, escalationWords, eventWord, STORY_SYSTEM_PROMPT } from "@/lib/scout/stories";

const news = (headline: string, source = "reuters", symbols = ["NVDA"], ts = "2026-11-09T13:00:00Z"): NewsItem => ({ id: Math.random(), ts, headline, summary: "", symbols, source, url: `https://www.${source}.com/x` });

describe("story stages (the NVDA shape)", () => {
  it("sees institutions acting, and spying as a shock", () => {
    expect(escalationWords("Nvidia board hires former U.S. attorney to investigate Huang ties")).toEqual(expect.arrayContaining(["board hires", "former u.s. attorney"]));
    expect(escalationWords("Three House committees ask Huang for a briefing")).toEqual(expect.arrayContaining(["committees", "briefing"]));
    expect(escalationWords("Huang resigns; CFO named interim CEO")).toEqual(expect.arrayContaining(["resigns", "interim ceo"]));
    expect(escalationWords("Nvidia unveils new chip")).toEqual([]);
    expect(eventWord("US intelligence linked a Huang contact to Chinese spying")).toBe("spying");
    expect(eventWord("SPY closes higher")).toBeNull();
  });

  it("a new stage on a ticker with an open story needs only 2 mainstream headlines", () => {
    const items = [news("Nvidia board launches outside investigation of CEO reports"), news("Nvidia board hires law firm over Huang reports", "bloomberg")];
    expect(detectStories(items)).toHaveLength(0);
    const s = detectStories(items, { openTickers: new Set(["NVDA"]) });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ key: "NVDA", escalationHits: 2 });
  });

  it("numbers stages from the desk's earlier reads and shows them to the desk", () => {
    const [s] = detectStories([news("Nvidia board hires former U.S. attorney to probe Huang"), news("Nvidia shares drop as board opens probe", "cnbc"), news("Board investigation weighs on Nvidia", "wsj")], { openTickers: new Set(["NVDA"]) });
    attachHistory(s, [{ etDate: "2026-10-28", key: "NVDA", stage: 1, summary: "NYT: US intelligence links a Huang contact to Chinese spying; Nvidia denies." }, { etDate: "2026-11-09", key: "NVDA", stage: 9, summary: "today's read is not history" }], "2026-11-09");
    expect(s.stage).toBe(2);
    expect(s.history).toHaveLength(1);
    const p = buildStoryPrompt([s], "2026-11-09");
    expect(p).toMatch(/Stage 2 of a story first seen 2026-10-28: an institution has acted\. Who has to act next\?/);
    expect(p).toMatch(/earlier, 2026-10-28 \(stage 1\): NYT/);
    expect(p).toMatch(/institutions acting: .*board hires/);
  });

  it("no stage without an institution acting", () => {
    const [s] = detectStories([news("Nvidia stock falls", "reuters"), news("Nvidia shares slide on spying report", "cnbc"), news("Spying report hits Nvidia", "wsj"), news("Nvidia espionage worries", "bloomberg")]);
    attachHistory(s, [{ etDate: "2026-10-28", key: "NVDA", stage: 1, summary: "x" }], "2026-11-02");
    expect(s.stage).toBeUndefined();
    expect(buildStoryPrompt([s], "2026-11-02")).toMatch(/Seen before \(first 2026-10-28\); no institution acting/);
  });

  it("the desk is asked about key-person risk, confounders and stages", () => {
    expect(STORY_SYSTEM_PROMPT).toMatch(/one person's company/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/What else is moving the stock/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/Who has to act next|who has to act next/);
  });

  it("a new stage restarts the follow-up clock; an ordinary re-read does not", () => {
    const seen = storiesSeen([
      { term: "story: NVDA", createdAt: "2026-10-28T16:00:00Z", tickersHint: ["NVDA"] },
      { term: "story: NVDA → NVDA", createdAt: "2026-11-02T16:00:00Z", tickersHint: ["NVDA"] }, // re-read after the cooldown
      { term: "story: NVDA (stage 2) → NVDA", createdAt: "2026-11-09T16:00:00Z", tickersHint: ["NVDA"] },
    ], "2026-11-12");
    expect(seen).toEqual([{ key: "NVDA", date: "2026-11-09", tickers: ["NVDA"] }]);
    const followed = storiesSeen([
      { term: "story: NVDA (stage 2) → NVDA", createdAt: "2026-11-09T16:00:00Z", tickersHint: ["NVDA"] },
      { term: "story: NVDA (follow-up) → AMD", createdAt: "2026-11-11T17:00:00Z", tickersHint: ["AMD"] },
    ], "2026-11-12");
    expect(followed).toEqual([]); // followed up since its latest stage
    const restaged = storiesSeen([
      { term: "story: NVDA (follow-up) → AMD", createdAt: "2026-11-11T17:00:00Z", tickersHint: ["AMD"] },
      { term: "story: NVDA (stage 3) → NVDA", createdAt: "2026-11-12T16:00:00Z", tickersHint: ["NVDA"] },
    ], "2026-11-14");
    expect(restaged.map((s) => s.date)).toEqual(["2026-11-12"]);
  });
});

const bar = (date: string, c: number): DailyBar => ({ symbol: "X", date, o: c, h: c, l: c, c, v: 1 });

describe("options pricing read", () => {
  it("parses OCC symbols", () => {
    expect(parseOcc("NVDA261218C00150000")).toEqual({ root: "NVDA", expiry: "2026-12-18", type: "call", strike: 150 });
    expect(parseOcc("BRK.B261218P00480500")).toEqual({ root: "BRK.B", expiry: "2026-12-18", type: "put", strike: 480.5 });
    expect(parseOcc("junk")).toBeNull();
  });

  it("median implied vol of near-the-money contracts 20-60 days out", () => {
    const snaps = {
      NVDA261218C00150000: { impliedVolatility: 0.6 }, // 34 days, at the money
      NVDA261218C00155000: { impliedVolatility: 0.7 }, // +3.3%
      NVDA261218C00170000: { impliedVolatility: 0.9 }, // too far out of the money
      NVDA261120C00150000: { impliedVolatility: 1.5 }, // 6 days: too short
      NVDA261218C00145000: { impliedVolatility: null },
    };
    const a = atmIv(snaps, 150, "2026-11-14")!;
    expect(a.contracts).toBe(2);
    expect(a.iv).toBeCloseTo(0.65, 10);
    expect(atmIv({}, 150, "2026-11-14")).toBeNull();
  });

  it("realized vol and the expensive / cheap label", () => {
    const flat = Array.from({ length: 25 }, (_, i) => bar(`2026-10-${String(i + 1).padStart(2, "0")}`, 100 * (i % 2 ? 1.02 : 1)));
    const rv = realizedVol(flat)!;
    expect(rv).toBeGreaterThan(0.3);
    expect(realizedVol(flat.slice(0, 5))).toBeNull();
    expect(describeOptions("NVDA", rv * 2, rv, 6).label).toBe("expensive");
    expect(describeOptions("NVDA", rv, rv, 6).label).toBe("cheap");
    expect(describeOptions("NVDA", rv * 1.3, rv, 6).label).toBe("normal");
    expect(describeOptions("NVDA", 0.5, null, 6)).toMatchObject({ label: "unknown", ratio: null });
    expect(describeOptions("NVDA", 0.62, 0.31, 6).line).toMatch(/62% vs 20-day realized 31% \(2\.0x: options look expensive/);
  });

  it("the option snapshots path is market data and allowed; trading paths still are not", () => {
    expect(() => assertReadOnlyEndpoint(DATA_HOST, "/v1beta1/options/snapshots/NVDA")).not.toThrow();
    expect(() => assertReadOnlyEndpoint(DATA_HOST, "/v1beta1/options/snapshots/BRK.B")).not.toThrow();
    expect(() => assertReadOnlyEndpoint(DATA_HOST, "/v1beta1/options/snapshots/NVDA/orders")).toThrow(/read-only/);
  });
});
