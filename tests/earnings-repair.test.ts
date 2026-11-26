import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData } from "@/lib/alpaca";
import { query, setQuerierForTests } from "@/lib/db";
import { EARN_VERSION, getScan, measuredLate, repairLateScans, scansSince } from "@/lib/scout/earnings";
import { mergeReportDates } from "@/lib/sources/earnings-data";

describe("one line per earnings report on the chart", () => {
  it("dates a day or two apart from different sources are the same report", () => {
    // The SEC dates the report by its filing (Nov 24); a calendar says Nov 25. One report, one line.
    expect(mergeReportDates([["2026-08-26", "2026-11-24"], ["2026-11-24"], ["2026-05-27", "2026-08-27", "2026-11-25"]])).toEqual(["2026-05-27", "2026-08-26", "2026-11-24"]);
    expect(mergeReportDates([[], ["2026-11-25", "2026-11-25"], ["bad"]])).toEqual(["2026-11-25"]);
    // Two quarters are never merged.
    expect(mergeReportDates([["2026-08-26"], ["2026-11-24"]])).toEqual(["2026-08-26", "2026-11-24"]);
  });
});

describe("a row measured a day late is measured again (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("the reaction and run-up come from the report day; the first measurement stays on file", async () => {
    const sessions = Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    const report = "2026-11-24", ri = sessions.indexOf(report);
    await scansSince(1, report); // creates the tables
    // History in the mid-cap group so ranks exist: run-ups spread from -25% to +25%.
    for (let i = 0; i < 150; i++) await pg.query(`INSERT INTO earnings_history (symbol, report_date, surprise, cap_group, eps_actual, runup_10d) VALUES ($1, '2026-06-01', $2, 'mid', 1, $3)`, [`H${i}`, (i - 75) / 10000, (i - 75) / 3]);
    // ANF-like: slid 12% over the ten sessions before the report, jumped 14% on the report day, 5% more the day after.
    const price = (i: number) => (i < ri - 10 ? 160 : i < ri ? 160 * (1 - 0.012 * (i - (ri - 10) + 1)) : i === ri ? 160 * 0.88 * 1.14 : 160 * 0.88 * 1.14 * 1.05);
    const bar = (symbol: string, date: string, c: number, v: number): DailyBar => ({ symbol, date, o: c, h: c, l: c, c, v });
    const bars = sessions.flatMap((d, i) => [bar("ANF", d, price(i), i === ri ? 6e6 : i === ri + 1 ? 4e6 : 2e6), bar("SPY", d, 700, 1e7)]);
    const data = { getDailyBars: async (syms: readonly string[], start: string, end: string) => bars.filter((b) => syms.includes(b.symbol) && b.date >= start && b.date <= end) } as unknown as MarketData;
    // What the older scan stored: measured on Nov 25, so the "run-up" included the jump.
    const wrong = { eps_actual: 3.82, eps_consensus: 3.15, consensus_source: "snapshot", consensus_captured_at: "2026-11-24T13:20:00Z", surprise: 0.004, surprise_pct_rank: 82, rank_basis: 150, revenue_actual: null, revenue_consensus: null, revenue_surprise_pct: null, revenue_beat: null, reaction_pct: 5.5, volume_ratio: 1.99, runup_10d_pct: 13.4, runup_pct_rank: 93.4, days_after_quarter_end: 24, market_cap_b: 5.85, cap_group: "$2-10B", sector: "Consumer Discretionary", price: 176.96, year_ago_eps: 2.36, year_ago_source: "nasdaq calendar" };
    const id = Number((await query(`INSERT INTO earnings_scans (version, symbol, report_date, reaction_date, timing, setup, reason, numbers) VALUES ($1, 'ANF', $2, '2026-11-25', 'before_open', 'A++', NULL, $3) RETURNING id`, [EARN_VERSION, report, JSON.stringify(wrong)]))[0].id);
    expect(measuredLate((await getScan(id))!)).toBe(true);

    expect(await repairLateScans(data, new Date("2026-11-26T15:00:00Z"))).toMatch(/^1 of 1 rows measured again on the report day; setup changed: ANF A\+\+ -> A\+$/);
    const s = (await getScan(id))!;
    expect(s.reactionDate).toBe(report);
    expect(Math.round(s.numbers.reaction_pct)).toBe(14); // the report day's jump, not the day after's 5%
    expect(s.numbers.runup_10d_pct).toBeLessThan(-10); // it slid into the report: no run-up
    expect(s.setup).toBe("A+"); // a big beat on volume, reported early, but not after a run-up
    expect(measuredLate(s)).toBe(false);
    expect(s.fixed?.was).toMatchObject({ reactionDate: "2026-11-25", setup: "A++", reaction_pct: 5.5, runup_10d_pct: 13.4 });
    // The first measurement is still what the scan table holds, and it cannot be changed.
    expect((await query(`SELECT setup, reaction_date FROM earnings_scans WHERE id = $1`, [id]))[0].setup).toBe("A++");
    await expect(query(`UPDATE earnings_scan_fixes SET setup = 'A'`)).rejects.toThrow();
    expect(await repairLateScans(data, new Date("2026-11-26T15:05:00Z"))).toBe("no rows measured on the wrong day");
  });
});
