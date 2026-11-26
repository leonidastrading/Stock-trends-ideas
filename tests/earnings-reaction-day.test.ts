import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { allTracks, measuredLate, reactionDay, scanEarnings, scansSince, snapshotConsensus } from "@/lib/scout/earnings";

const sessions = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));

describe("which day a report's reaction is measured on", () => {
  it("the report day for a before-open report, the next session otherwise; the time frozen before the release wins", () => {
    expect(reactionDay("2026-10-21", "before_open", null, sessions)).toEqual({ timing: "before_open", date: "2026-10-21" });
    expect(reactionDay("2026-10-21", "after_close", null, sessions)).toEqual({ timing: "after_close", date: "2026-10-22" });
    expect(reactionDay("2026-10-23", "unknown", null, sessions)).toEqual({ timing: "unknown", date: "2026-10-26" });
    // The calendar dropped the time once the results were out; the snapshot taken before them still has it.
    expect(reactionDay("2026-10-21", "unknown", "before_open", sessions)).toEqual({ timing: "before_open", date: "2026-10-21" });
    expect(reactionDay("2026-10-21", "before_open", "unknown", sessions)).toEqual({ timing: "before_open", date: "2026-10-21" });
  });

  it("knows an older row that was measured a day late", () => {
    expect(measuredLate({ timing: "before_open", reportDate: "2026-11-24", reactionDate: "2026-11-25" })).toBe(true);
    expect(measuredLate({ timing: "before_open", reportDate: "2026-11-24", reactionDate: "2026-11-24" })).toBe(false);
    expect(measuredLate({ timing: "after_close", reportDate: "2026-11-24", reactionDate: "2026-11-25" })).toBe(false);
  });
});

describe("the nightly scan and the time of day (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("measures a before-open report on its own day when the calendar has dropped the time, and a report missed that night on its own day too", async () => {
    const day1 = "2026-10-21", day2 = "2026-10-22", ti = sessions.indexOf(day1);
    await scansSince(1, day1); // creates the tables
    const bar = (symbol: string, date: string, c: number, v: number): DailyBar => ({ symbol, date, o: c, h: c * 1.01, l: c * 0.98, c, v });
    // A 10% jump on the report day, then a quiet drift.
    const series = (symbol: string, jump: number) => sessions.slice(0, ti + 20).map((d, i) => bar(symbol, d, i < ti ? 50 : 50 * (1 + jump) * (1 + (i - ti) * 0.002), i === ti ? 600000 : 200000));
    const bars = [...series("SPY", 0), ...series("DROP", 0.1), ...series("SLOW", 0.1)];
    const data = {
      getCalendar: async (start: string, end: string) => sessions.filter((d) => d >= start && d <= end).map((date) => ({ date, open: "09:30", close: "16:00" })),
      getDailyBars: async (syms: readonly string[], start: string, end: string) => bars.filter((b) => syms.includes(b.symbol) && b.date >= start && b.date <= end),
      getNews: async () => [],
    } as unknown as MarketData;
    const row = (symbol: string, time: string, eps: string) => ({ symbol, time, eps, epsForecast: "$1.00", marketCap: "$5,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.00" });
    let calendar: Record<string, unknown[]> = { [day1]: [row("DROP", "time-pre-market", ""), row("SLOW", "time-pre-market", "")] };
    const nasdaq = (async (url: string) => {
      const d = /date=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1];
      if (d) return Response.json({ data: { rows: calendar[d] ?? [] } });
      if (url.includes("/summary")) return Response.json({ data: { summaryData: { Sector: { value: "Technology" } } } });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    expect(await snapshotConsensus(data, new Date("2026-10-20T22:30:00Z"), nasdaq, {} as NodeJS.ProcessEnv)).toBe(2);

    // That night: DROP's results are in but the calendar no longer says when it reported; SLOW's numbers are not out yet.
    calendar = { [day1]: [row("DROP", "time-not-supplied", "$1.50"), row("SLOW", "time-pre-market", "")] };
    await scanEarnings(data, new Date(`${day1}T22:30:00Z`), nasdaq, {} as NodeJS.ProcessEnv);
    let scans = await scansSince(4000, day2);
    expect(scans.map((s) => [s.symbol, s.reportDate, s.reactionDate, s.timing, Math.round(s.numbers.reaction_pct), s.numbers.scanned_late ?? false])).toEqual([["DROP", day1, day1, "before_open", 10, false]]);

    // The next night SLOW's numbers are there: measured on its own reaction day, entered one session later.
    calendar = { [day1]: [row("DROP", "time-not-supplied", "$1.50"), row("SLOW", "time-pre-market", "$1.50")] };
    await scanEarnings(data, new Date(`${day2}T22:30:00Z`), nasdaq, {} as NodeJS.ProcessEnv);
    scans = await scansSince(4000, day2);
    const slow = scans.find((s) => s.symbol === "SLOW")!;
    expect([slow.reactionDate, slow.timing, Math.round(slow.numbers.reaction_pct), slow.numbers.scanned_late]).toEqual([day1, "before_open", 10, true]);
    const tracks = await allTracks();
    const entryOf = (sym: string) => tracks.find((t) => t.scanId === scans.find((s) => s.symbol === sym)!.id)!.entryDate;
    expect([entryOf("DROP"), entryOf("SLOW")]).toEqual([day2, "2026-10-23"]);
    expect(scans.filter((s) => s.symbol === "DROP")).toHaveLength(1);
  });
});
