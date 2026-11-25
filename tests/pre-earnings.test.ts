import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData, NewsItem } from "@/lib/alpaca";
import { query as q, setQuerierForTests } from "@/lib/db";
import { canScreen, fadeLeg, filingLeg, headlinesNear, ideaLeg, joltLeg, joltOf, nextWeekdays, preEarnings, preEarningsFor, preEarningsLine, preEarningsRecord, reactionOf, risingWarnings, runPreEarnings, scoreTable, slideLeg, slideOf, type FilingNote } from "@/lib/scout/pre-earnings";
import { addDays } from "@/lib/time";

/** Weekday closes ending on `end`, oldest first. */
function series(end: string, closes: number[]): Array<{ date: string; c: number }> {
  const dates: string[] = [];
  for (let d = end; dates.length < closes.length; d = addDays(d, -1)) { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) dates.unshift(d); }
  return closes.map((c, i) => ({ date: dates[i], c }));
}
const flat = (n: number, level = 100) => Array.from({ length: n }, (_, i) => level * (1 + (i % 2 ? 0.004 : -0.004)));

describe("the price signs", () => {
  it("a slide is measured against SPY over 30 days", () => {
    const stock = series("2026-11-20", [...flat(40), 90, 80, 70, 66]);
    const spy = series("2026-11-20", flat(44, 500));
    const s = slideOf(stock, spy)!;
    expect(s.pct).toBeLessThan(-30);
    expect(Math.abs(s.spyPct!)).toBeLessThan(1);
    expect(slideLeg(s)?.text).toMatch(/^down 3\d(\.\d)?% in 30 days \(SPY/);
    // The whole market fell as much: not a sign about this stock.
    expect(slideLeg({ pct: -22, spyPct: -15 })).toBeNull();
    expect(slideLeg({ pct: -22, spyPct: 1 })?.kind).toBe("slide");
    // Too new to have a 30-day move.
    expect(slideOf(series("2026-11-20", flat(10)), spy)).toBeNull();
  });

  it("an unexplained drop is several times the usual daily move, in the last three sessions, with no headline", () => {
    const calm = series("2026-11-20", [...flat(60), 80]);
    const j = joltOf(calm)!;
    expect(j.date).toBe("2026-11-20");
    expect(j.pct).toBeLessThan(-19);
    expect(j.usual).toBeLessThan(1);
    expect(joltLeg(j, 0)?.text).toMatch(/with no headline/);
    // A headline that day explains it; an unread news feed proves nothing.
    expect(joltLeg(j, 2)).toBeNull();
    expect(joltLeg(j, null)).toBeNull();
    // A stock that swings 6% every day has not been jolted by a 7% fall.
    const wild = series("2026-11-20", [...Array.from({ length: 60 }, (_, i) => (i % 2 ? 106 : 100)), 93]);
    expect(joltOf(wild)).toBeNull();
    // A drop four sessions back is no longer looked at.
    expect(joltOf(series("2026-11-20", [...flat(60), 80, 80.1, 80, 80.1]))).toBeNull();
    expect(headlinesNear([{ ts: "2026-11-20T15:00:00Z" }, { ts: "2026-11-19T22:00:00Z" }, { ts: "2026-11-17T15:00:00Z" }], "2026-11-20")).toBe(2);
  });

  it("a fall through takeover talk counts from the close before the first report", () => {
    const bars = series("2026-11-20", [...flat(30), 100, 99, 95, 92]);
    const news = [{ ts: "2026-11-18T14:00:00Z", headline: "Acme explores sale after takeover interest, sources say", url: "https://example.com/a" }, { ts: "2026-11-19T14:00:00Z", headline: "Acme launches a new chip", url: "" }];
    expect(fadeLeg(news, bars)?.text).toMatch(/takeover talk was reported on 2026-11-18 .* -8% since the close before it/);
    // The stock held its gain: nothing faded. A signed deal is not talk.
    expect(fadeLeg(news, series("2026-11-20", [...flat(30), 100, 99, 108, 112]))).toBeNull();
    expect(fadeLeg([{ ts: "2026-11-18T14:00:00Z", headline: "Acme agrees to be acquired by Bigco for $4 billion", url: "" }], bars)).toBeNull();
  });
});

describe("the filing and idea signs", () => {
  const note = (over: Partial<FilingNote>): FilingNote => ({ form: "10-Q", filed: "2026-09-04", url: "https://www.sec.gov/x", flag: null, negatives: [], shifts: [], ...over });

  it("the AI's read decides when there is one; without it, warning words that rose are enough", () => {
    expect(filingLeg(note({ flag: "red_flag" }), "2026-11-20")?.text).toMatch(/10-Q filed 2026-09-04: red flag/);
    expect(filingLeg(note({ flag: "mixed", negatives: ["A new risk: memory prices are rising and supply is short"] }), "2026-11-20")?.text).toMatch(/a negative change .*memory prices/);
    expect(filingLeg(note({ flag: "positive", negatives: ["minor"] }), "2026-11-20")).toBeNull();
    // Read and found routine: the word counts do not overrule it.
    expect(filingLeg(note({ flag: "routine", shifts: [{ word: "shortage", before: 0, after: 2 }] }), "2026-11-20")).toBeNull();
    expect(filingLeg(note({ shifts: [{ word: "shortage", before: 0, after: 1.2 }, { word: "demand", before: 1, after: 4 }] }), "2026-11-20")?.text).toMatch(/warning words rose .*"shortage" 0 → 1.2/);
    // "Demand" up is not a warning; a warning word that became rarer is not one either; an old filing is not looked at.
    expect(risingWarnings([{ word: "demand", before: 1, after: 4 }, { word: "tariff", before: 3, after: 1 }])).toEqual([]);
    expect(filingLeg(note({ flag: "red_flag", filed: "2026-03-01" }), "2026-11-20")).toBeNull();
    expect(filingLeg(null, "2026-11-20")).toBeNull();
  });

  it("only a recent short idea that names the stock counts", () => {
    const dots = [{ etDate: "2026-11-15", ideas: [{ title: "Memory costs squeeze chip buyers", direction: "short", tickers: ["AMBA", "QCOM"] }, { title: "Long idea", direction: "long", tickers: ["OKAY"] }] }] as never;
    const themes = [{ etDate: "2026-10-01", themes: [{ title: "Old short", direction: "short", tickers: ["OLDY"] }] }] as never;
    expect(ideaLeg("AMBA", dots, themes, "2026-11-20")?.text).toBe('named in a short idea on Dots (2026-11-15): "Memory costs squeeze chip buyers"');
    expect(ideaLeg("OKAY", dots, themes, "2026-11-20")).toBeNull();
    expect(ideaLeg("OLDY", dots, themes, "2026-11-20")).toBeNull();
  });
});

describe("when a stock is screened and how its reaction is measured", () => {
  it("screens until the report: the day itself only for an after-close reporter, until the bell", () => {
    expect(canScreen("2026-11-24", "before_open", "2026-11-23", 600)).toBe(true);
    expect(canScreen("2026-11-24", "before_open", "2026-11-24", 600)).toBe(false);
    expect(canScreen("2026-11-24", "unknown", "2026-11-24", 600)).toBe(false);
    expect(canScreen("2026-11-24", "after_close", "2026-11-24", 15 * 60 + 59)).toBe(true);
    expect(canScreen("2026-11-24", "after_close", "2026-11-24", 16 * 60)).toBe(false);
    expect(nextWeekdays("2026-11-20", 3)).toEqual(["2026-11-20", "2026-11-23", "2026-11-24"]);
  });

  it("the reaction is close to close across the report, by when it reported", () => {
    const bars = [{ date: "2026-11-20", c: 100 }, { date: "2026-11-23", c: 90 }, { date: "2026-11-24", c: 72 }, { date: "2026-11-25", c: 70 }];
    const spy = [{ date: "2026-11-20", c: 500 }, { date: "2026-11-23", c: 505 }, { date: "2026-11-24", c: 510.05 }, { date: "2026-11-25", c: 510 }];
    expect(reactionOf("2026-11-23", "after_close", bars, spy)).toEqual({ refDate: "2026-11-23", refClose: 90, outDate: "2026-11-24", pct: -20, spyPct: 1 });
    expect(reactionOf("2026-11-24", "before_open", bars, spy)).toMatchObject({ refDate: "2026-11-23", outDate: "2026-11-24", pct: -20 });
    // Time not given: the close before the report day to the close after it.
    expect(reactionOf("2026-11-24", "unknown", bars, spy)).toMatchObject({ refDate: "2026-11-23", outDate: "2026-11-25", pct: -22.2 });
    // The session after the report has not closed yet.
    expect(reactionOf("2026-11-25", "after_close", bars, spy)).toBeNull();
  });

  it("the record compares flagged stocks with the rest", () => {
    const t = scoreTable([
      { flagged: true, signs: 2, reactionPct: -12, spyPct: 1 }, { flagged: true, signs: 3, reactionPct: 4, spyPct: 0 },
      { flagged: false, signs: 1, reactionPct: -1, spyPct: 0 }, { flagged: false, signs: 0, reactionPct: 2, spyPct: 0 }, { flagged: false, signs: 0, reactionPct: null, spyPct: null },
    ]);
    expect(t.map((r) => [r.group, r.n, r.vsSpy.mean, r.fellPct, r.fell5Pct])).toEqual([["flagged", 2, -4.5, 50, 50], ["one sign", 1, -1, 100, 0], ["no sign", 1, 2, 0, 0]]);
  });
});

describe("a run of the screen (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  const calendar = (rows: Array<Record<string, string>>): typeof fetch => async (url) => {
    const date = /date=(\d{4}-\d{2}-\d{2})/.exec(String(url))?.[1];
    return new Response(JSON.stringify({ data: { rows: date === "2026-11-23" ? rows : [] } }), { status: 200 });
  };
  const rows = [
    { symbol: "AMBA", name: "Ambarella, Inc.", time: "time-after-hours", marketCap: "$2,900,000,000", fiscalQuarterEnding: "Oct/2026" },
    { symbol: "OKAY", name: "Okay Corp", time: "time-after-hours", marketCap: "$5,000,000,000", fiscalQuarterEnding: "Sep/2026" },
    { symbol: "TINY", name: "Tiny Co", time: "time-after-hours", marketCap: "$40,000,000", fiscalQuarterEnding: "Sep/2026" },
  ];
  // Ambarella: steady, then a slide, then a 20% drop in the session before its report; and the day after.
  const amba = series("2026-11-24", [...flat(60), 97, 94, 90, 88, 85, 84, 83, 82, 66, 46]);
  const okay = series("2026-11-24", flat(70, 50));
  const spy = series("2026-11-24", flat(70, 500));
  const market = (upTo: string): MarketData => ({
    getDailyBars: async (symbols: readonly string[]) => [["AMBA", amba], ["OKAY", okay], ["SPY", spy]].filter(([s]) => symbols.includes(s as string)).flatMap(([s, xs]) => (xs as typeof amba).filter((b) => b.date <= upTo).map((b) => ({ symbol: s as string, date: b.date, o: b.c, h: b.c, l: b.c, c: b.c, v: 1 } as DailyBar))),
    getNews: async (symbols: string[]) => (symbols[0] === "AMBA" ? [{ id: 1, ts: "2026-11-10T15:00:00Z", headline: "Ambarella explores sale after takeover interest, sources say", summary: "", symbols: ["AMBA"], source: "x", url: "https://example.com/amba" } as NewsItem] : []),
  } as unknown as MarketData);

  it("flags the stock with several signs before its report and keeps every screened stock", async () => {
    const line = await runPreEarnings({ data: market("2026-11-23"), env: {} as NodeJS.ProcessEnv, now: new Date("2026-11-23T15:00:00Z"), fetchImpl: calendar(rows) });
    expect(line).toMatch(/^pre-earnings: 2 stocks reporting in the next 5 sessions screened \(\$300M\+\); 1 flagged \(AMBA slide\+jolt\+fade\); 0 with one sign/);
    const { ahead } = await preEarnings("2026-11-23");
    expect(ahead.map((r) => [r.symbol, r.flagged, r.legs.map((l) => l.kind)])).toEqual([["AMBA", true, ["slide", "jolt", "fade"]]]);
    expect(ahead[0].firstFlaggedAt).toBe("2026-11-23T15:00:00.000Z");
    expect(preEarningsLine(ahead[0])).toMatch(/^AMBA reports 2026-11-23 \(after the close\)\. Warning signs seen beforehand: down 3\d/);
    // The small company is not screened; the quiet one is kept without signs, as part of the comparison.
    expect((await q(`SELECT symbol, n_legs FROM pre_earnings ORDER BY symbol`)).map((r) => [r.symbol, Number(r.n_legs)])).toEqual([["AMBA", 3], ["OKAY", 0]]);
    expect((await preEarningsFor(["AMBA", "OKAY"], "2026-11-23")).map((r) => r.symbol)).toEqual(["AMBA"]);
  });

  it("reads the newest filing comparison on file for the stock", async () => {
    await q(`INSERT INTO filing_diffs (accession, cik, ticker, company, form, filed, url, flag, source, ai, mechanical) VALUES ('0001-26-1', '1', 'OKAY', 'Okay Corp', '10-Q', '2026-10-30', 'https://www.sec.gov/okay', 'mixed', 'card', $1, $2)`,
      [JSON.stringify({ headline: "h", flag: "mixed", findings: [{ type: "new_risk", direction: "negative", quote: "q", why: "A new risk about a supplier shortage" }], research: false, research_direction: "none", research_why: "" }), JSON.stringify({ shifts: [] })]);
    const line = await runPreEarnings({ data: market("2026-11-23"), env: {} as NodeJS.ProcessEnv, now: new Date("2026-11-23T15:30:00Z"), fetchImpl: calendar(rows) });
    expect(line).toMatch(/1 flagged \(AMBA slide\+jolt\+fade\); 1 with one sign/);
    const okay = (await preEarnings("2026-11-23")).ahead.find((r) => r.symbol === "OKAY")!;
    expect([okay.flagged, okay.legs[0].kind, okay.legs[0].text]).toEqual([false, "filing", "10-Q filed 2026-10-30: a negative change against a year earlier (A new risk about a supplier shortage)"]);
  });

  it("a later look with fewer signs does not take the flag back, and nothing is screened after the bell", async () => {
    const quiet = { ...market("2026-11-23"), getNews: async () => [{ id: 2, ts: "2026-11-23T14:00:00Z", headline: "Ambarella shares fall", summary: "", symbols: ["AMBA"], source: "x", url: "" }] } as unknown as MarketData;
    await runPreEarnings({ data: quiet, env: {} as NodeJS.ProcessEnv, now: new Date("2026-11-23T16:00:00Z"), fetchImpl: calendar(rows) });
    const row = (await preEarnings("2026-11-23")).ahead[0];
    expect([row.flagged, row.legs.length, row.firstFlaggedAt]).toEqual([true, 3, "2026-11-23T15:00:00.000Z"]);
    expect(await runPreEarnings({ data: market("2026-11-23"), env: {} as NodeJS.ProcessEnv, now: new Date("2026-11-23T21:30:00Z"), fetchImpl: calendar(rows) })).toMatch(/nothing to screen/);
  });

  it("writes the reaction beside every screened stock once the session after the report has closed", async () => {
    // The morning after: the session after the report is still open.
    await runPreEarnings({ data: market("2026-11-24"), env: {} as NodeJS.ProcessEnv, now: new Date("2026-11-24T15:00:00Z"), fetchImpl: calendar([]) });
    expect((await preEarningsRecord()).map((r) => r.n)).toEqual([0, 0, 0]);
    const line = await runPreEarnings({ data: market("2026-11-24"), env: {} as NodeJS.ProcessEnv, now: new Date("2026-11-25T15:00:00Z"), fetchImpl: calendar([]) });
    expect(line).toMatch(/2 past reports measured/);
    const { ahead, past } = await preEarnings("2026-11-25");
    expect(ahead).toEqual([]);
    expect(past.filter((r) => r.flagged).map((r) => [r.symbol, r.refDate, r.outDate, r.reactionPct])).toEqual([["AMBA", "2026-11-23", "2026-11-24", -30.3]]);
    const record = await preEarningsRecord();
    expect(record.map((r) => [r.group, r.n])).toEqual([["flagged", 1], ["one sign", 1], ["no sign", 0]]);
    expect(record[0].fell5Pct).toBe(100);
  });
});
