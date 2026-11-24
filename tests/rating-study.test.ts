import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/alpaca";
import { eventReturns, ratingAction, reactionDay, stat, studyTable, type StudyEvent } from "@/lib/scout/rating-study";

describe("rating headlines", () => {
  it("reads the wires' usual wording, and how strong the change is", () => {
    expect(ratingAction("Morgan Stanley Downgrades Nike to Equal-Weight, Lowers Price Target to $79")).toEqual({ kind: "downgrade", broker: "Morgan Stanley", to: "Equal-Weight", strength: "mild", topBroker: true });
    expect(ratingAction("JP Morgan Downgrades Snap to Underweight, Announces $7 Price Target")).toMatchObject({ kind: "downgrade", to: "Underweight", strength: "strong" });
    expect(ratingAction("Keybanc Downgrades Tesla to Sector Weight")).toMatchObject({ kind: "downgrade", broker: "Keybanc", strength: "mild", topBroker: false });
    expect(ratingAction("B of A Securities Upgrades Apple to Buy, Raises Price Target to $225")).toMatchObject({ kind: "upgrade", to: "Buy", strength: "strong" });
    expect(ratingAction("Wells Fargo Upgrades Ford Motor to Equal-Weight")).toMatchObject({ kind: "upgrade", strength: "mild" });
  });
  it("ignores round-ups, commentary and price-target changes", () => {
    for (const h of [
      "Benzinga's Top Upgrades, Downgrades For November 20, 2026",
      "Why Nike Shares Are Falling After Analyst Downgrades",
      "Morgan Stanley Maintains Overweight on Nike, Lowers Price Target to $79",
      "Top 5 Downgrades For Thursday",
      "Nike shares fall as analysts downgrade the stock to hold",
    ]) expect(ratingAction(h)).toBeNull();
  });
});

describe("the reaction day and what followed", () => {
  const sessions = ["2024-03-01", "2024-03-04", "2024-03-05", "2024-03-06"];
  it("is the first session whose close came after the headline", () => {
    expect(reactionDay("2024-03-04T11:30:00Z", sessions)).toBe("2024-03-04"); // 6:30 AM ET, before the open
    expect(reactionDay("2024-03-04T19:00:00Z", sessions)).toBe("2024-03-04"); // 2 PM ET, during the session
    expect(reactionDay("2024-03-04T21:30:00Z", sessions)).toBe("2024-03-05"); // 4:30 PM ET, after the close
    expect(reactionDay("2024-03-02T15:00:00Z", sessions)).toBe("2024-03-04"); // a Saturday
    expect(reactionDay("2024-03-06T21:30:00Z", sessions)).toBeNull();
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
    const e = (over: Partial<StudyEvent>): StudyEvent => ({ symbol: "X", day: "2020-05-01", kind: "downgrade", strong: false, topBroker: false, brokers: 1, reaction: -1, x: { 5: -1, 10: -1, 20: -2, 60: -3 }, o: { 20: -1.5, 60: -2.5 }, ...over });
    const t = studyTable([e({}), e({ strong: true, reaction: -8, day: "2023-02-01", brokers: 2 }), e({ kind: "upgrade", strong: true, x: { 5: 1, 10: 1, 20: 2, 60: 3 } })]);
    const n = Object.fromEntries(t.map((r) => [r.label, r.n]));
    expect(n).toMatchObject({ "All downgrades": 2, "To Sell / Underperform / Underweight": 1, "To Neutral / Hold / Equal-Weight": 1, "Two or more brokers the same day": 1, "Stock fell 5%+ on the day (vs SPY)": 1, "2019-2021": 1, "2022-2025": 1, "All upgrades (comparison)": 1 });
    expect(t[0].x20.mean).toBe(-2);
    expect(t.find((r) => r.label === "All upgrades (comparison)")!.x20.mean).toBe(2);
  });
});

describe("the paced job (PGlite)", () => {
  it("reads the history page by page, resumes where a pass stopped, and counts several brokers on a day once", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { setQuerierForTests } = await import("@/lib/db");
    const { runRatingStudy, studyEvents, studyState, studySymbols } = await import("@/lib/scout/rating-study");
    const pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    try {
      const first = studySymbols()[0];
      // 80 sessions of flat SPY; the stock falls 4% on the reaction day and 0.1% a day after.
      const days: string[] = [];
      for (let d = new Date("2019-01-02T00:00:00Z"); days.length < 80; d = new Date(d.getTime() + 86400_000)) if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
      const bar = (symbol: string, date: string, c: number): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v: 1 });
      const price = (i: number) => (i < 5 ? 100 : 96 * Math.pow(0.999, i - 5));
      let pages = 0;
      const news = [
        { id: 1, ts: `${days[5]}T11:00:00Z`, headline: "Morgan Stanley Downgrades Acme to Underweight, Lowers Price Target to $80", summary: "", symbols: [first], source: "benzinga", url: "" },
        { id: 2, ts: `${days[5]}T12:00:00Z`, headline: "Keybanc Downgrades Acme to Sector Weight", summary: "", symbols: [first], source: "benzinga", url: "" },
        { id: 3, ts: `${days[6]}T12:00:00Z`, headline: "Acme shares fall after downgrades", summary: "", symbols: [first], source: "benzinga", url: "" },
      ];
      const data = {
        getDailyBars: async (symbols: readonly string[]) => symbols.flatMap((s) => (s === "SPY" ? days.map((d) => bar("SPY", d, 400)) : s === first ? days.map((d, i) => bar(s, d, price(i))) : [])),
        getNews: async () => [], getCalendar: async () => [],
        // Two pages for the first batch (a token in between), nothing for the others.
        getNewsPage: async (symbols: string[], _a: Date, _b: Date, token?: string | null) => {
          pages++;
          if (!symbols.includes(first)) return { items: [], next: null };
          return token === "p2" ? { items: news.slice(2), next: null } : { items: news.slice(0, 2), next: "p2" };
        },
      } as never;
      // A pass with no time left reads nothing and keeps its place.
      expect((await runRatingStudy(data, Date.now() - 1)).more).toBe(true);
      expect(pages).toBe(0);
      const done = await runRatingStudy(data, Date.now() + 60_000);
      expect(done).toMatchObject({ more: false });
      expect(done.line).toMatch(/^rating study: done · .* 3 headlines, 2 rating changes$/);
      expect((await studyState())!.done).toBe(true);
      const events = await studyEvents();
      expect(events).toHaveLength(1); // two brokers, one stock, one day
      expect(events[0]).toMatchObject({ symbol: first, day: days[5], kind: "downgrade", strong: true, topBroker: true, brokers: 2, reaction: -4 });
      expect(events[0].x[20]).toBeCloseTo((Math.pow(0.999, 20) - 1) * 100, 1);
      expect(events[0].x[60]).not.toBeNull();
      // Once done, another pass does nothing.
      const before = pages;
      expect(await runRatingStudy(data)).toEqual({ line: "rating study: done", more: false });
      expect(pages).toBe(before);
      // A history that comes back empty is never "done": the study probes what the history holds, once, and waits.
      await pg.query(`DELETE FROM dashboard_cache WHERE key LIKE 'rating-study:%'`);
      let probes = 0;
      const empty = { ...(data as object), getNewsPage: async () => { probes++; return { items: [], next: null }; } } as never;
      const r = await runRatingStudy(empty, Date.now() + 60_000);
      expect(r.more).toBe(false);
      expect(r.line).toMatch(/returned no headlines .* Probe: AAPL 2019-03: 0 · /);
      expect((await studyState())).toMatchObject({ done: false, probeVersion: 1 });
      const after = probes;
      expect((await runRatingStudy(empty)).line).toBe("rating study: waiting (the news history came back empty)");
      expect(probes).toBe(after);
    } finally {
      setQuerierForTests(null);
    }
  });
});
