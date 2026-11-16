import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { allCards, allTracks, classify, exitDate, pctRank, reactionStats, scanEarnings, scansSince, score, toCard, updateEarningsTracks, writeCards, type Numbers } from "@/lib/scout/earnings";
import type { CallModel } from "@/lib/scout/llm";
import { money, parseCalendarDay, parseSector, quarterEndOf } from "@/lib/sources/earnings-data";

const base: Numbers = { eps_actual: 1.5, eps_consensus: 1.0, surprise: 0.01, surprise_pct_rank: 92, rank_basis: 500, revenue_actual: null, revenue_consensus: null, revenue_surprise_pct: null, reaction_pct: 4, volume_ratio: 2.1, runup_10d_pct: 6, days_after_quarter_end: 25, market_cap_b: 5, cap_group: "$2-10B", sector: "Technology", price: 50, last_year_eps: 1.1 };

describe("earnings data", () => {
  it("reads Nasdaq's calendar rows (street EPS, timing, quarter end) and its sector", () => {
    const rows = parseCalendarDay({ data: { rows: [
      { symbol: "ACME", name: "Acme Corp", time: "time-pre-market", eps: "$1.50", epsForecast: "$1.00", marketCap: "$5,123,456,789", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.10", noOfEsts: "8" },
      { symbol: "LOSS", name: "Loss Inc", time: "time-after-hours", eps: "($0.12)", epsForecast: "($0.05)", marketCap: "$1,500,000,000", fiscalQuarterEnding: "Aug/2026", lastYearEPS: "N/A", noOfEsts: "3" },
      { symbol: "bad sym!", name: "x" },
    ] } }, "2026-10-21");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: "ACME", timing: "before_open", epsActual: 1.5, epsEstimate: 1, marketCap: 5123456789, quarterEnd: "2026-09-30", lastYearEps: 1.1, estimates: 8 });
    expect(rows[1]).toMatchObject({ timing: "after_close", epsActual: -0.12, epsEstimate: -0.05, quarterEnd: "2026-08-31", lastYearEps: null });
    expect(money("—")).toBeNull();
    expect(quarterEndOf("Feb/2028")).toBe("2028-02-29");
    expect(parseSector({ data: { summaryData: { Sector: { label: "Sector", value: "Technology" } } } })).toBe("Technology");
  });
});

describe("earnings setups", () => {
  it("A, A+ and A++ by rank, volume, timeliness and run-up; study setups B and C; reasons when not", () => {
    expect(classify({ ...base, days_after_quarter_end: 50 }, 5).setup).toBe("A");
    expect(classify(base, 10).setup).toBe("A+");
    expect(classify(base, 5).setup).toBe("A++");
    expect(classify({ ...base, surprise_pct_rank: 70 }, 5)).toEqual({ setup: null, reason: "surprise rank 70 (needs 80+)" });
    expect(classify({ ...base, volume_ratio: 1.1 }, 5).reason).toMatch(/volume only 1.1x normal/);
    expect(classify({ ...base, sector: "Utilities" }, 5).reason).toBe("defensive sector (Utilities)");
    expect(classify({ ...base, surprise_pct_rank: null, rank_basis: 40 }, 5).reason).toMatch(/not enough surprise history in the \$2-10B group yet \(40 reports\)/);
    expect(classify({ ...base, eps_actual: 0.9, reaction_pct: 9, market_cap_b: 3 }, 5).setup).toBe("B");
    expect(classify({ ...base, eps_actual: 1.0, eps_consensus: 1.2, last_year_eps: 1.3, reaction_pct: -9, market_cap_b: 40 }, 5).setup).toBe("C");
    expect(pctRank(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(50);
  });

  it("exits the day before the next report, or after 60 sessions", () => {
    const sessions = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    expect(exitDate(sessions, "2026-10-22", "2026-11-10")).toBe("2026-11-09");
    expect(exitDate(sessions, "2026-10-22", null)).toBe(sessions[sessions.indexOf("2026-10-22") + 59]);
    expect(exitDate(sessions, "2026-10-22", "2027-06-01")).toBe(sessions[sessions.indexOf("2026-10-22") + 59]);
  });

  it("the card keeps the feed's numbers and the code's promotion rule", () => {
    const reply = (o: object) => JSON.stringify({ beat_quality: "high", beat_drivers: ["revenue", "margin"], guidance: "raised", red_flags: [], thesis: "Revenue and guidance up.", ai_recommendation: "promote", confidence: 70, unknowns: [], ...o });
    const s = { symbol: "ACME", setup: "A+" as const, reportDate: "2026-10-21", timing: "before_open" as const, numbers: base, exitDate: "2027-01-19", nextReport: "2027-01-20", nextKnown: false };
    expect(toCard(reply({}), s)).toMatchObject({ ai_recommendation: "promote", numbers: base, next_earnings_date: "unknown", exit_plan: "close of 2027-01-19, 60 trading days or the day before the expected next report" });
    expect(toCard(reply({ guidance: "cut" }), s).ai_recommendation).toBe("log_only");
    expect(toCard(reply({ beat_quality: "low" }), s).ai_recommendation).toBe("log_only");
    expect(toCard(reply({}), s).unknowns).toContain("revenue (no FINNHUB_API_KEY, or not in the feed)");
  });

  it("scores excess vs SPY and vs peers, with the t-stat; shorts count the other way", () => {
    const g = score("x", [{ ret: 5, spy: 1, peer: 2 }, { ret: -1, spy: 0, peer: -2 }, { ret: 3, spy: 1, peer: 1 }]);
    expect(g).toMatchObject({ n: 3, win: 67, meanSpy: 1.67, medianSpy: 2, meanPeer: 2 });
    expect(score("s", [{ ret: -4, spy: 1, peer: 0 }], true).meanSpy).toBe(5);
  });
});

describe("earnings desk: one night (PGlite, fake Nasdaq and prices)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("scans tonight's reports, opens paper tracks, writes the card, and closes at the planned exit", async () => {
    // Weekday sessions from Sep 1 to Mar 31.
    const sessions = Array.from({ length: 220 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    const today = "2026-10-21";
    const ti = sessions.indexOf(today);
    // A history of small surprises in the $2-10B group, so ACME's beat ranks at the top.
    await scansSince(1); // creates the tables
    for (let i = 0; i < 150; i++) await pg.query(`INSERT INTO earnings_history (symbol, report_date, surprise, cap_group) VALUES ($1, $2, $3, 'mid')`, [`H${i}`, "2026-06-01", (i - 75) / 10000]);
    const bar = (symbol: string, date: string, c: number, v: number): DailyBar => ({ symbol, date, o: c, h: c * 1.01, l: c * 0.98, c, v });
    const series = (symbol: string, jump: number, vol: number) => sessions.slice(0, ti + 70).map((d, i) => bar(symbol, d, i < ti ? 50 + i * 0.05 : (50 + ti * 0.05) * (1 + jump) * (1 + (i - ti) * 0.002), i === ti ? vol * 3 : vol));
    const bars = [...series("SPY", 0, 1e7), ...series("ACME", 0.06, 200000), ...series("PEER", 0.01, 200000), ...series("UTIL", 0.06, 200000)];
    const data = {
      getCalendar: async () => sessions.map((date) => ({ date, open: "09:30", close: "16:00" })),
      getDailyBars: async (syms: readonly string[], start: string, end: string) => bars.filter((b) => syms.includes(b.symbol) && b.date >= start && b.date <= end),
      getNews: async () => [],
    } as unknown as MarketData;
    const nasdaq = (async (url: string) => {
      if (url.includes("/calendar/earnings?date=2026-10-21")) return Response.json({ data: { rows: [
        { symbol: "ACME", time: "time-pre-market", eps: "$1.50", epsForecast: "$1.00", marketCap: "$5,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.10" },
        { symbol: "PEER", time: "time-pre-market", eps: "$1.01", epsForecast: "$1.00", marketCap: "$4,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$0.90" },
        { symbol: "UTIL", time: "time-pre-market", eps: "$1.50", epsForecast: "$1.00", marketCap: "$6,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.00" },
      ] } });
      if (url.includes("/calendar/earnings?date=")) return Response.json({ data: { rows: [] } });
      if (url.includes("/quote/UTIL/summary")) return Response.json({ data: { summaryData: { Sector: { value: "Utilities" } } } });
      if (url.includes("/summary")) return Response.json({ data: { summaryData: { Sector: { value: "Technology" } } } });
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    const r = await scanEarnings(data, new Date(`${today}T22:30:00Z`), nasdaq, {} as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ day: today, reports: 3, inUniverse: 3, setups: { "A+": 1 } });
    const scans = await scansSince(4000);
    expect(scans.find((s) => s.symbol === "UTIL")!.reason).toBe("defensive sector (Utilities)");
    const acme = scans.find((s) => s.symbol === "ACME")!;
    expect(acme).toMatchObject({ setup: "A+", reactionDate: today, timing: "before_open" });
    expect(acme.numbers).toMatchObject({ eps_actual: 1.5, eps_consensus: 1, days_after_quarter_end: 21, cap_group: "$2-10B", sector: "Technology" });
    expect(acme.numbers.surprise_pct_rank).toBe(100);
    expect(acme.numbers.volume_ratio).toBeGreaterThan(1.3);
    const [t] = await allTracks();
    expect(t).toMatchObject({ entryDate: sessions[ti + 1], closed: false });

    const callModel: CallModel = async ({ purpose }) => {
      expect(purpose).toBe("earnings_card");
      return { text: JSON.stringify({ beat_quality: "high", beat_drivers: ["revenue"], guidance: "raised", red_flags: [], thesis: "t", ai_recommendation: "promote", confidence: 66, unknowns: [] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01 };
    };
    expect(await writeCards({ data, callModel, now: new Date(`${today}T22:35:00Z`), env: {} as NodeJS.ProcessEnv }, Date.now() + 120_000)).toBe("1 card(s) written");
    expect((await allCards())[0].card).toMatchObject({ ticker: "ACME", setup: "A+", ai_recommendation: "promote", numbers: { eps_actual: 1.5 } });

    // Past the planned exit: the track closes with its return, SPY's and the same-week peers'.
    const exit = t.exitDate!;
    await updateEarningsTracks(data, new Date(`${exit}T23:00:00Z`));
    const [done] = await allTracks();
    expect(done.closed).toBe(true);
    expect(done.retPct).toBeGreaterThan(0);
    expect(done.spyPct).not.toBeNull();
  });
});
