import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { CARD_JSON_SCHEMA, parseCard } from "@/lib/scout/card";
import { assessGap, buildFollowupPrompt, storiesSeen } from "@/lib/scout/followup";
import { parseStoryTriage, STORY_JSON_SCHEMA, STORY_SYSTEM_PROMPT } from "@/lib/scout/stories";
import { sampleCard } from "./card.test";

const bar = (symbol: string, date: string, c: number): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v: 1 } as DailyBar);

describe("reaction-gap follow-up", () => {
  it("collects stories seen 1-10 days ago with their tickers, skipping follow-ups", () => {
    const seen = storiesSeen([
      { term: "story: UNH", createdAt: "2026-11-05T16:00:00Z", tickersHint: ["UNH"] }, // skipped by the desk: still followed up
      { term: "story: UNH → CVS", createdAt: "2026-11-06T16:00:00Z", tickersHint: ["CVS"] },
      { term: "story: macro:war → XLE", createdAt: "2026-11-10T16:00:00Z", tickersHint: ["XLE"] },
      { term: "story: macro:tariffs", createdAt: "2026-11-10T16:00:00Z", tickersHint: [] }, // no ticker: nothing to measure
      { term: "story: NVDA (follow-up) → AMD", createdAt: "2026-11-12T16:00:00Z", tickersHint: ["AMD"] },
      { term: "story: AAPL", createdAt: "2026-11-14T15:00:00Z", tickersHint: ["AAPL"] }, // today: too fresh
      { term: "AI agents", createdAt: "2026-11-08T15:00:00Z", tickersHint: ["V"] },
    ], "2026-11-14");
    expect(seen.map((s) => s.key).sort()).toEqual(["UNH", "macro:war"]);
    expect(seen.find((s) => s.key === "UNH")).toEqual({ key: "UNH", date: "2026-11-05", tickers: ["UNH", "CVS"] });
  });

  it("flags a UNH-style gap: loud coverage, flat stock vs SPY", () => {
    const g = assessGap({
      key: "UNH", ticker: "UNH", storyDate: "2026-11-04", today: "2026-11-07", baselinePerDay: 3,
      counts: [{ date: "2026-11-04", stories: 60 }, { date: "2026-11-05", stories: 45 }, { date: "2026-11-06", stories: 30 }],
      bars: [bar("UNH", "2026-11-03", 610), bar("UNH", "2026-11-04", 600), bar("UNH", "2026-11-06", 598)],
      spyBars: [bar("SPY", "2026-11-03", 600), bar("SPY", "2026-11-06", 603)],
    });
    expect(g).toMatchObject({ loud: true, quiet: true, gap: true, recentPerDay: 37.5, ageDays: 3 });
    expect(g.excessPct).toBeCloseTo(-2.5, 1);
    expect(g.why).toMatch(/still loud.*quiet/);
  });

  it("no gap when the stock already moved, or the coverage faded", () => {
    const base = { key: "X", ticker: "X", storyDate: "2026-11-04", today: "2026-11-07", baselinePerDay: 3, spyBars: [bar("SPY", "2026-11-03", 100), bar("SPY", "2026-11-06", 100)] };
    const moved = assessGap({ ...base, counts: [{ date: "2026-11-05", stories: 20 }], bars: [bar("X", "2026-11-03", 100), bar("X", "2026-11-06", 85)] });
    expect(moved).toMatchObject({ loud: true, quiet: false, gap: false });
    const faded = assessGap({ ...base, counts: [{ date: "2026-11-05", stories: 5 }, { date: "2026-11-06", stories: 4 }], bars: [bar("X", "2026-11-03", 100), bar("X", "2026-11-06", 101)] });
    expect(faded).toMatchObject({ loud: false, quiet: true, gap: false }); // 4.5/day < 2 × 3/day
    const unpriced = assessGap({ ...base, counts: [{ date: "2026-11-05", stories: 20 }], bars: [bar("X", "2026-11-06", 101)] });
    expect(unpriced).toMatchObject({ excessPct: null, gap: false });
  });

  it("the follow-up prompt carries the gap and asks for the reaction trade", () => {
    const p = buildFollowupPrompt([{ key: "UNH", ticker: "UNH", storyDate: "2026-11-04", ageDays: 3, recentPerDay: 37.5, baselinePerDay: 3, movePct: -2, spyMovePct: 0.5, excessPct: -2.5, building: false, loud: true, quiet: true, gap: true, why: "37.5 stories/day lately vs 3/day before (still loud); UNH -2% vs SPY +0.5%", headlines: [{ at: "2026-11-06T14:00:00Z", source: "reuters", headline: "Lawmakers target insurers' claim denials" }] }], "2026-11-07");
    expect(p).toMatch(/## UNH \(follow-up\) — UNH: first seen 2026-11-04 \(3 days ago\)/);
    expect(p).toMatch(/reaction trade/);
    expect(p).toMatch(/Lawmakers target/);
  });

  it("the story desk asks the three questions and accepts reaction trades", () => {
    expect(STORY_SYSTEM_PROMPT).toMatch(/What does it reveal/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/Whose incentives just changed/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/smaller than the story's intensity/);
    expect(JSON.stringify(STORY_JSON_SCHEMA)).toMatch(/"reaction"/);
    const t = parseStoryTriage(JSON.stringify({ stories: [{ key: "UNH (follow-up)", summary: "s", skip: false, skip_reason: "", trades: [{ ticker: "CVS", direction: "short", role: "reaction", horizon_days: 30, thesis: "PBM break-up talk", why_not_priced: "bill not filed yet", invalidation: "no bill in 6 weeks" }] }] }));
    expect(t.stories[0].trades[0]).toMatchObject({ ticker: "CVS", role: "reaction" });
  });

  it("cards carry a how-to-trade note; older cards without one still parse", () => {
    expect((CARD_JSON_SCHEMA.required as readonly string[])).toContain("expression");
    const withNote = parseCard(JSON.stringify(sampleCard({ expression: "Slow grind over 4-6 weeks: shares, or puts with 2+ months to expiry." })));
    expect(withNote.expression).toMatch(/2\+ months/);
    const old = sampleCard();
    delete (old as { expression?: string }).expression;
    expect(parseCard(JSON.stringify(old)).expression).toBeUndefined();
  });
});

describe("follow-up pass end to end (PGlite, fake model)", () => {
  it("finds the gap, asks the desk once, researches the reaction trade, and never repeats", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { query, setQuerierForTests } = await import("@/lib/db");
    const store = await import("@/lib/scout/store");
    const { runFollowups } = await import("@/lib/scout/followup");
    const { addDays, toEt } = await import("@/lib/time");
    const pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    try {
      const now = new Date();
      const today = toEt(now).date;
      const storyDay = addDays(today, -4);
      const v = await store.ensureVersion("h", "m", "high", {});
      await store.addCandidate({ versionId: v.id, origin: "scout", term: "story: UNH", kindHint: "event", tickersHint: ["UNH"], observation: null, trigger: null, outcome: "rejected", reason: "story desk skipped: crime, not business", cardId: null });
      await query(`UPDATE candidates SET created_at = $1::timestamptz`, [`${storyDay}T17:00:00Z`]);
      for (let d = -30; d <= 0; d++) {
        const date = addDays(today, d);
        const n = date < storyDay ? 2 : date === storyDay ? 80 : 40;
        await query(`INSERT INTO ticker_news_daily (date, symbol, stories, mainstream) VALUES ($1, 'UNH', $2, 1)`, [date, n]);
      }
      const bars: DailyBar[] = [];
      for (let d = -10; d <= 0; d++) {
        const date = addDays(today, d);
        bars.push(bar("UNH", date, date < storyDay ? 600 : 590), bar("SPY", date, 600));
      }
      const prompts: string[] = [];
      const desk = JSON.stringify({ stories: [{ key: "UNH (follow-up)", summary: "Public anger at insurers after the shooting; lawmakers circling PBMs.", skip: false, skip_reason: "", trades: [{ ticker: "UNH", direction: "short", role: "reaction", horizon_days: 30, thesis: "political backlash", why_not_priced: "no bill yet", invalidation: "coverage fades with no political action in 3 weeks" }] }] });
      const deps = {
        data: { getDailyBars: async () => bars, getNews: async () => [{ id: 1, ts: `${today}T13:00:00Z`, headline: "Senators float breaking up PBMs", summary: "", symbols: ["UNH"], source: "reuters", url: "https://www.reuters.com/x" }], getCalendar: async () => [] },
        sources: [], now, env: {} as NodeJS.ProcessEnv,
        callModel: async ({ user, purpose }: { user: string; purpose?: string }) => {
          prompts.push(`${purpose}: ${user}`);
          const text = purpose === "stories" ? desk : JSON.stringify(sampleCard({ kind: "event", direction: "short", tickers: [{ symbol: "UNH", sector: "health_care", revenue_share_pct: 100, share_is_estimate: false, why: "the target" }] }));
          return { text, stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
        },
      };
      const r = await runFollowups(deps as never);
      expect(r.error).toBeNull();
      expect(r.checked).toHaveLength(1);
      expect(r.checked[0]).toMatchObject({ ticker: "UNH", gap: true, recentPerDay: 40, baselinePerDay: 2 });
      expect(prompts[0]).toMatch(/^stories: .*UNH \(follow-up\) — UNH/s);
      expect(r.researched).toEqual([expect.objectContaining({ term: "story: UNH (follow-up) → UNH", outcome: expect.stringMatching(/^card: /) })]);
      expect(prompts.some((p) => p.startsWith("research: ") && /Reaction gap/.test(p))).toBe(true);

      const again = await runFollowups(deps as never);
      expect(again.checked).toHaveLength(0); // once per story
    } finally {
      setQuerierForTests(null);
    }
  });
});
