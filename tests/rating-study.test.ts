import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { eventReturns, gradeAction, reactionDay, stat, studyTable, type StudyEvent } from "@/lib/scout/rating-study";

describe("rating changes from the grades history", () => {
  it("reads upgrades and downgrades, and how strong the change is", () => {
    expect(gradeAction({ gradingCompany: "Morgan Stanley", previousGrade: "Overweight", newGrade: "Equal-Weight", action: "downgrade" })).toEqual({ kind: "downgrade", broker: "Morgan Stanley", to: "Equal-Weight", strength: "mild", topBroker: true });
    expect(gradeAction({ gradingCompany: "JP Morgan", newGrade: "Underweight", action: "downgrade" })).toMatchObject({ kind: "downgrade", strength: "strong" });
    expect(gradeAction({ gradingCompany: "Keybanc", newGrade: "Sector Weight", action: "Downgrade" })).toMatchObject({ kind: "downgrade", strength: "mild", topBroker: false });
    expect(gradeAction({ gradingCompany: "B of A Securities", newGrade: "Buy", action: "upgrade" })).toMatchObject({ kind: "upgrade", strength: "strong" });
    expect(gradeAction({ gradingCompany: "Wells Fargo", newGrade: "Equal-Weight", action: "upgrade" })).toMatchObject({ kind: "upgrade", strength: "mild" });
  });
  it("ignores ratings kept, first ratings and rows with no broker", () => {
    for (const row of [{ gradingCompany: "Citigroup", newGrade: "Buy", action: "maintain" }, { gradingCompany: "UBS", newGrade: "Neutral", action: "initiate" }, { gradingCompany: "", newGrade: "Sell", action: "downgrade" }, { gradingCompany: "UBS", newGrade: "Sell" }]) expect(gradeAction(row)).toBeNull();
  });
});

describe("the reaction day and what followed", () => {
  const sessions = ["2024-03-01", "2024-03-04", "2024-03-05", "2024-03-06"];
  it("is the day the change is dated, or the next session", () => {
    expect(reactionDay("2024-03-04", sessions)).toBe("2024-03-04");
    expect(reactionDay("2024-03-02", sessions)).toBe("2024-03-04"); // a Saturday
    expect(reactionDay("2024-03-07", sessions)).toBeNull();
  });
  it("measures the stock against SPY from the reaction close and from the next open", () => {
    const bar = (symbol: string, date: string, o: number, c: number): DailyBar => ({ symbol, date, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
    const stock = [bar("X", "2024-03-01", 100, 100), bar("X", "2024-03-04", 96, 95), bar("X", "2024-03-05", 94, 93), bar("X", "2024-03-06", 92, 90.25)];
    const spy = new Map([bar("SPY", "2024-03-01", 500, 500), bar("SPY", "2024-03-04", 500, 500), bar("SPY", "2024-03-05", 500, 505), bar("SPY", "2024-03-06", 505, 510)].map((b) => [b.date, b]));
    const r = eventReturns(stock, spy, "2024-03-04", [1, 2])!;
    expect(r.reaction).toBe(-5); // -5% while SPY was flat
    expect(r.x[1]).toBe(-3.11); // 93/95 - 1 = -2.11%, SPY +1%
    expect(r.x[2]).toBe(-7); // 90.25/95 - 1 = -5%, SPY +2%
    expect(r.o[2]).toBe(-5.99); // 90.25/94 - 1 = -3.99% from the next open, SPY 510/500 - 1 = +2%
    expect(r.x[5] ?? null).toBeNull();
    expect(eventReturns(stock, spy, "2024-03-01", [1])).toBeNull(); // no day before to measure the reaction from
    expect(eventReturns(stock, spy, "2024-03-07", [1])).toBeNull();
  });
});

describe("the results table", () => {
  it("averages, counts and t-statistics", () => {
    expect(stat([-2, -1, 0, 1, null])).toEqual({ n: 4, mean: -0.5, median: -0.5, negShare: 50, t: -0.77 });
    expect(stat([])).toEqual({ n: 0, mean: null, median: null, negShare: null, t: null });
  });
  it("splits downgrades by strength, broker, reaction and period, with upgrades as the comparison", () => {
    const e = (over: Partial<StudyEvent>): StudyEvent => ({ symbol: "X", day: "2020-05-01", kind: "downgrade", strong: false, topBroker: false, brokers: 1, reaction: -1, x: { 5: -1, 10: -1, 20: -2, 60: -3 }, o: { 5: -0.5, 10: -1, 20: -1.5, 60: -2.5 }, ...over });
    const t = studyTable([e({}), e({ strong: true, reaction: -8, day: "2023-02-01", brokers: 2 }), e({ kind: "upgrade", strong: true, x: { 5: 1, 10: 1, 20: 2, 60: 3 } })]);
    const n = Object.fromEntries(t.map((r) => [r.label, r.n]));
    expect(n).toMatchObject({ "All downgrades": 2, "To Sell / Underperform / Underweight": 1, "To Neutral / Hold / Equal-Weight": 1, "Two or more brokers the same day": 1, "Stock fell 5%+ on the day (vs SPY)": 1, "2019-2021": 1, "2022-2023": 1, "2024-2026": 0, "All upgrades (comparison)": 1 });
    expect(t[0].x20.mean).toBe(-2);
    expect(t.find((r) => r.label === "All upgrades (comparison)")!.x20.mean).toBe(2);
  });
});

describe("the paced job (PGlite)", () => {
  it("reads one stock per request, resumes where a pass stopped, keeps to the day's allowance, and counts several brokers on a day once", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { setQuerierForTests } = await import("@/lib/db");
    const { RATING_STUDY, runRatingStudy, studyEvents, studyState, studySymbols } = await import("@/lib/scout/rating-study");
    const pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    try {
      const all = studySymbols(), first = all[0];
      // 80 sessions of flat SPY from 2019; the stock falls 4% on the reaction day and 0.1% a day after.
      const days: string[] = [];
      for (let d = new Date("2019-01-02T00:00:00Z"); days.length < 80; d = new Date(d.getTime() + 86400_000)) if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
      const bar = (symbol: string, date: string, c: number): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v: 1 });
      const price = (i: number) => (i < 5 ? 100 : 96 * Math.pow(0.999, i - 5));
      const data = {
        getDailyBars: async (symbols: readonly string[]) => symbols.flatMap((s) => (s === "SPY" ? days.map((d) => bar("SPY", d, 400)) : s === first ? days.map((d, i) => bar(s, d, price(i))) : [])),
        getNews: async () => [], getCalendar: async () => [],
      } as never;
      const asked: string[] = [];
      const fmp: typeof fetch = async (url) => {
        const sym = new URL(String(url)).searchParams.get("symbol")!;
        asked.push(sym);
        if (sym === all[1]) return new Response("{}", { status: 402 }); // not covered by the plan
        if (sym !== first) return new Response("[]", { status: 200 });
        return new Response(JSON.stringify([
          { symbol: sym, date: days[5], gradingCompany: "Morgan Stanley", previousGrade: "Equal-Weight", newGrade: "Underweight", action: "downgrade" },
          { symbol: sym, date: days[5], gradingCompany: "Keybanc", previousGrade: "Overweight", newGrade: "Sector Weight", action: "downgrade" },
          { symbol: sym, date: days[6], gradingCompany: "Citigroup", previousGrade: "Buy", newGrade: "Buy", action: "maintain" },
          { symbol: sym, date: "2015-03-02", gradingCompany: "UBS", previousGrade: "Buy", newGrade: "Sell", action: "downgrade" }, // before the study starts
        ]), { status: 200 });
      };
      const env = { FMP_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
      const at = new Date("2026-11-24T15:00:00Z");
      // A pass with no time left reads nothing and keeps its place.
      expect((await runRatingStudy(data, Date.now() - 1, env, fmp, at)).more).toBe(true);
      expect(asked).toEqual([]);
      // The day's allowance stops it part-way; it goes on the next day and finishes.
      const one = await runRatingStudy(data, Date.now() + 120_000, env, fmp, at);
      expect(asked.length).toBe(RATING_STUDY.perDay);
      expect(one).toMatchObject({ more: false });
      expect(one.line).toMatch(new RegExp(`^rating study: ${RATING_STUDY.perDay} of ${all.length} stocks \\(today's allowance used`));
      expect((await runRatingStudy(data, Date.now() + 120_000, env, fmp, at)).line).toMatch(/waiting \(today's allowance/);
      // While waiting it asks once why a stock came back empty (the provider's own answer, for the page), and only once.
      expect(asked.length).toBe(RATING_STUDY.perDay + 1);
      expect(asked.at(-1)).toBe(all[1]);
      expect((await studyState())!.refusal).toMatch(new RegExp(`^${all[1]}: HTTP 402`));
      await runRatingStudy(data, Date.now() + 120_000, env, fmp, at);
      expect(asked.length).toBe(RATING_STUDY.perDay + 1);
      asked.splice(RATING_STUDY.perDay, 1);
      const two = await runRatingStudy(data, Date.now() + 120_000, env, fmp, new Date("2026-11-25T15:00:00Z"));
      expect(two.line).toMatch(/^rating study: done · 2 rating changes read, 2 measured, \d+ stocks with no history$/);
      expect(asked).toEqual(all); // every stock asked exactly once, in order
      expect((await studyState())!).toMatchObject({ done: true, events: 2 });
      const events = await studyEvents();
      expect(events).toHaveLength(1); // two brokers, one stock, one day
      expect(events[0]).toMatchObject({ symbol: first, day: days[5], kind: "downgrade", strong: true, topBroker: true, brokers: 2, reaction: -4 });
      expect(events[0].o[20]).toBeCloseTo((Math.pow(0.999, 19) - 1) * 100, 1); // from the next session's open: one day's fall fewer
      expect(events[0].x[20]).toBeCloseTo((Math.pow(0.999, 20) - 1) * 100, 1); // from the reaction close
      expect(events[0].o[5]).not.toBeNull();
      expect(events[0].x[60]).not.toBeNull();
      // Once done, another pass does nothing.
      expect(await runRatingStudy(data, Date.now() + 1000, env, fmp, at)).toEqual({ line: "rating study: done", more: false });
      expect(asked.length).toBe(all.length);
      expect(await runRatingStudy(data, undefined, {} as NodeJS.ProcessEnv)).toMatchObject({ more: false });
    } finally {
      setQuerierForTests(null);
    }
  });
});
