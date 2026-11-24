import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { allCards, allDocs, allTracks, classify, exitDate, guidanceFromText, pctRank, peerBench, refreshExits, releaseCutoff, scanEarnings, scansSince, score, snapshotConsensus, toCard, updateEarningsTracks, writeCards, type Numbers } from "@/lib/scout/earnings";
import type { CallModel } from "@/lib/scout/llm";
import { money, parseCalendarDay, parseSector, quarterEndOf } from "@/lib/sources/earnings-data";

const base: Numbers = {
  eps_actual: 1.5, eps_consensus: 1.0, consensus_source: "snapshot", consensus_captured_at: "2026-10-20T22:30:00Z", surprise: 0.01, surprise_pct_rank: 92, rank_basis: 500,
  revenue_actual: null, revenue_consensus: null, revenue_surprise_pct: null, revenue_beat: null, reaction_pct: 4, volume_ratio: 2.1, runup_10d_pct: 6, runup_pct_rank: 50,
  days_after_quarter_end: 25, market_cap_b: 5, cap_group: "$2-10B", sector: "Technology", price: 50, year_ago_eps: 1.1, year_ago_source: "our history",
};

describe("earnings data", () => {
  it("reads Nasdaq's calendar rows (street EPS, timing, quarter end, year-ago EPS) and its sector", () => {
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
  it("A / A+ / A++ (run-up ranked on the trailing 12 months), A0 on quiet volume, study B and C, and reasons", () => {
    expect(classify({ ...base, days_after_quarter_end: 50 }).setup).toBe("A");
    expect(classify(base).setup).toBe("A+");
    expect(classify({ ...base, runup_pct_rank: 80 }).setup).toBe("A++");
    expect(classify({ ...base, runup_pct_rank: null }).setup).toBe("A+"); // no run-up history yet: not A++
    expect(classify({ ...base, volume_ratio: 1.1 }).setup).toBe("A0");
    // A big beat the market sold 7%+ is a study short (D), not an up-drift setup, whatever the volume.
    expect(classify({ ...base, reaction_pct: -7.7 })).toMatchObject({ setup: "D", reason: expect.stringMatching(/big beat the market sold \(-7\.7% vs SPY/) });
    expect(classify({ ...base, reaction_pct: -7.7, volume_ratio: 1.1 }).setup).toBe("D");
    expect(classify({ ...base, reaction_pct: -6.9 }).setup).not.toBe("D");
    expect(classify({ ...base, surprise_pct_rank: 70 })).toEqual({ setup: null, reason: "surprise rank 70 (needs 80+)" });
    expect(classify({ ...base, sector: "Utilities" }).reason).toBe("defensive sector (Utilities)");
    expect(classify({ ...base, consensus_source: "none" }).reason).toBe("no consensus snapshot from before the report (benchmark only)");
    expect(classify({ ...base, eps_actual: 0.9, reaction_pct: 9, market_cap_b: 3 }).setup).toBe("B");
    expect(classify({ ...base, eps_actual: 1.0, eps_consensus: 1.2, year_ago_eps: 1.3, reaction_pct: -9, market_cap_b: 40 }).setup).toBe("C");
    expect(classify({ ...base, eps_actual: 1.0, eps_consensus: 1.2, year_ago_eps: null, reaction_pct: -9, market_cap_b: 40, surprise_pct_rank: 10 }).setup).toBeNull(); // no year-ago EPS: no C
    expect(pctRank(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(50);
  });

  it("exits the day before the next report, or after 60 sessions; snapshots must come before the release", () => {
    const sessions = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    expect(exitDate(sessions, "2026-10-22", "2026-11-10")).toBe("2026-11-09");
    expect(exitDate(sessions, "2026-10-22", null)).toBe(sessions[sessions.indexOf("2026-10-22") + 59]);
    expect(releaseCutoff("2026-10-21", "before_open").toISOString()).toBe("2026-10-21T13:30:00.000Z");
    expect(releaseCutoff("2026-10-21", "after_close").toISOString()).toBe("2026-10-21T20:30:00.000Z");
  });

  it("reads guidance direction from the wording, without a model", () => {
    expect(guidanceFromText("The company raised its full-year guidance to $5.10.")).toBe("raised");
    expect(guidanceFromText("We are lowering our fiscal 2027 outlook given softer demand.")).toBe("cut");
    expect(guidanceFromText("Management reaffirmed its full-year guidance.")).toBe("reaffirmed");
    expect(guidanceFromText("Revenue grew 12%.")).toBe("unknown");
    expect(guidanceFromText(null)).toBe("unknown");
  });

  it("the card keeps the feed's numbers and the code's promotion rule", () => {
    const reply = (o: object) => JSON.stringify({ beat_quality: "high", beat_drivers: ["revenue", "margin"], guidance: "raised", red_flags: [], thesis: "Revenue and guidance up.", ai_recommendation: "promote", confidence: 70, unknowns: [], ...o });
    const s = { symbol: "ACME", setup: "A+" as const, reportDate: "2026-10-21", timing: "before_open" as const, numbers: base, exitDate: "2027-01-19", nextReport: "2027-01-20", nextKnown: false };
    expect(toCard(reply({}), s)).toMatchObject({ ai_recommendation: "promote", numbers: base, next_earnings_date: "unknown" });
    expect(toCard(reply({ guidance: "cut" }), s).ai_recommendation).toBe("log_only");
    expect(toCard(reply({ beat_quality: "low" }), s).ai_recommendation).toBe("log_only");
    expect(toCard(reply({}), s).unknowns).toContain("revenue vs consensus (not in Finnhub or Financial Modeling Prep)");
  });

  it("benchmarks each report against the other reports in its size group and week; t-stat clustered by week", () => {
    const b = peerBench([
      { scanId: 1, capGroup: "g", week: "w1", excess: 5, excessFromClose: 4 }, { scanId: 2, capGroup: "g", week: "w1", excess: 1, excessFromClose: 1 },
      { scanId: 3, capGroup: "g", week: "w1", excess: -1, excessFromClose: 0 }, { scanId: 4, capGroup: "g", week: "w1", excess: 0, excessFromClose: 2 },
      { scanId: 5, capGroup: "h", week: "w1", excess: 9, excessFromClose: 9 },
    ]);
    expect(b.get(1)).toEqual({ bench: 0, peers: 3, benchClose: 1 });
    expect(b.get(5)!.bench).toBeNull(); // fewer than 3 peers
    const g = score("x", [{ ret: 5, spy: 1, vsPeer: 2, vsPeerClose: 1, week: "w1" }, { ret: -1, spy: 0, vsPeer: -2, vsPeerClose: 0, week: "w1" }, { ret: 3, spy: 1, vsPeer: 1, vsPeerClose: 1, week: "w2" }, { ret: 3, spy: 1, vsPeer: 3, vsPeerClose: 1, week: "w3" }]);
    expect(g).toMatchObject({ n: 4, weeks: 3, win: 75, meanPeer: 1, meanPeerFromClose: 0.75 });
    expect(g.tClustered).not.toBeNull();
    expect(score("s", [{ ret: -4, spy: 1, vsPeer: -3, vsPeerClose: null, week: "w" }], true).meanSpy).toBe(5);
  });
});

describe("earnings desk: snapshot, one night, and the exit (PGlite, fake Nasdaq and prices)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("freezes consensus the evening before, scans with it, tracks every report, writes the card from pre-entry documents, and closes", async () => {
    const sessions = Array.from({ length: 220 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    const today = "2026-10-21";
    const ti = sessions.indexOf(today);
    await scansSince(1, today); // creates the tables
    // History of small surprises and run-ups in the $2-10B group, so ACME ranks at the top on both.
    for (let i = 0; i < 150; i++) await pg.query(`INSERT INTO earnings_history (symbol, report_date, surprise, cap_group, eps_actual, runup_10d) VALUES ($1, $2, $3, 'mid', 1, $4)`, [`H${i}`, "2026-06-01", (i - 75) / 10000, (i - 75) / 30]);
    // A year-ago actual for LAST (for setup C): its own history row.
    await pg.query(`INSERT INTO earnings_history (symbol, report_date, surprise, cap_group, eps_actual) VALUES ('LAST', '2025-10-22', 0, 'large', 2.0)`);
    const bar = (symbol: string, date: string, c: number, v: number): DailyBar => ({ symbol, date, o: c, h: c * 1.01, l: c * 0.98, c, v });
    const series = (symbol: string, jump: number, vol: number, runup = 0.05) => sessions.slice(0, ti + 70).map((d, i) => bar(symbol, d, i < ti ? 50 + i * runup : (50 + ti * runup) * (1 + jump) * (1 + (i - ti) * 0.002), i === ti ? vol * 3 : vol));
    const bars = [...series("SPY", 0, 1e7), ...series("ACME", 0.06, 200000, 0.4), ...series("PEER", 0.01, 200000), ...series("UTIL", 0.06, 200000), ...series("LAST", -0.09, 400000), ...series("NOSN", 0.06, 200000)];
    const data = {
      getCalendar: async (start: string, end: string) => sessions.filter((d) => d >= start && d <= end).map((date) => ({ date, open: "09:30", close: "16:00" })),
      getDailyBars: async (syms: readonly string[], start: string, end: string) => bars.filter((b) => syms.includes(b.symbol) && b.date >= start && b.date <= end),
      getNews: async () => [{ id: 1, ts: "2026-10-21T12:00:00Z", headline: "Acme beats, raises", summary: "", symbols: ["ACME"], source: "x", url: "u" }, { id: 2, ts: "2026-10-23T12:00:00Z", headline: "LATER NEWS", summary: "", symbols: ["ACME"], source: "x", url: "u" }],
    } as unknown as MarketData;
    let calendar: Record<string, unknown[]> = {
      "2026-10-21": [
        { symbol: "ACME", time: "time-pre-market", eps: "", epsForecast: "$1.00", marketCap: "$5,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.10" },
        { symbol: "PEER", time: "time-pre-market", eps: "", epsForecast: "$1.00", marketCap: "$4,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$0.90" },
        { symbol: "UTIL", time: "time-pre-market", eps: "", epsForecast: "$1.00", marketCap: "$6,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.00" },
        { symbol: "LAST", time: "time-pre-market", eps: "", epsForecast: "$2.10", marketCap: "$40,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$2.00" },
      ],
    };
    const nasdaq = (async (url: string) => {
      const d = /date=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1];
      if (d) return Response.json({ data: { rows: calendar[d] ?? [] } });
      if (url.includes("/quote/UTIL/summary")) return Response.json({ data: { summaryData: { Sector: { value: "Utilities" } } } });
      if (url.includes("/summary")) return Response.json({ data: { summaryData: { Sector: { value: "Technology" } } } });
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    // The evening before: consensus frozen (and refused once the release time has passed).
    expect(await snapshotConsensus(data, new Date("2026-10-20T22:30:00Z"), nasdaq, {} as NodeJS.ProcessEnv)).toBe(4);
    expect(await snapshotConsensus(data, new Date("2026-10-21T14:00:00Z"), nasdaq, {} as NodeJS.ProcessEnv)).toBe(0);

    // After the release the calendar shows actuals, and a revised estimate the scan must ignore; NOSN has no snapshot.
    calendar = { "2026-10-21": [
      { symbol: "ACME", time: "time-pre-market", eps: "$1.50", epsForecast: "$1.45", marketCap: "$5,500,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.10" },
      { symbol: "PEER", time: "time-pre-market", eps: "$1.01", epsForecast: "$1.00", marketCap: "$4,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$0.90" },
      { symbol: "UTIL", time: "time-pre-market", eps: "$1.50", epsForecast: "$1.00", marketCap: "$6,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.00" },
      { symbol: "LAST", time: "time-pre-market", eps: "$1.80", epsForecast: "$2.10", marketCap: "$40,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$2.00" },
      { symbol: "NOSN", time: "time-pre-market", eps: "$1.50", epsForecast: "$1.00", marketCap: "$5,000,000,000", fiscalQuarterEnding: "Sep/2026", lastYearEPS: "$1.00" },
    ] };
    const r = await scanEarnings(data, new Date(`${today}T22:30:00Z`), nasdaq, {} as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ day: today, reports: 5, inUniverse: 5, noSnapshot: 1, setups: { "A++": 1, C: 1 } });
    const scans = await scansSince(4000, today);
    const by = (s: string) => scans.find((x) => x.symbol === s)!;
    expect(by("ACME").numbers).toMatchObject({ eps_consensus: 1, consensus_source: "snapshot", consensus_captured_at: "2026-10-20T22:30:00.000Z", market_cap_b: 5, surprise_pct_rank: 100 });
    expect(by("ACME").numbers.runup_pct_rank).toBeGreaterThanOrEqual(66.7);
    expect(by("UTIL").reason).toBe("defensive sector (Utilities)");
    expect(by("NOSN").reason).toBe("no consensus snapshot from before the report (benchmark only)");
    expect(by("LAST")).toMatchObject({ setup: "C" });
    expect(by("LAST").numbers).toMatchObject({ year_ago_eps: 2, year_ago_source: "our history" });
    // Every report is tracked (the benchmark), setups or not.
    expect((await allTracks()).length).toBe(5);

    // The card: only documents before the paper entry.
    let seen = "";
    const callModel: CallModel = async ({ user }) => { seen = user; return { text: JSON.stringify({ beat_quality: "high", beat_drivers: ["revenue"], guidance: "raised", red_flags: [], thesis: "t", ai_recommendation: "promote", confidence: 66, unknowns: [] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01 }; };
    expect(await writeCards({ data, callModel, now: new Date("2026-10-25T22:35:00Z"), env: {} as NodeJS.ProcessEnv }, Date.now() + 120_000)).toBe("1 card(s) written");
    expect(seen).toContain("Acme beats, raises");
    expect(seen).not.toContain("LATER NEWS");
    expect((await allCards())[0].card).toMatchObject({ ticker: "ACME", setup: "A++", ai_recommendation: "promote" });
    expect((await allDocs())[0]).toMatchObject({ pressUrl: null, guidanceNumeric: "unknown" });

    // A confirmed next-report date moves the exit (and is logged).
    calendar = { [sessions[ti + 5]]: [{ symbol: "ACME", time: "time-pre-market", epsForecast: "$1.6", marketCap: "$5,000,000,000" }] };
    expect(await refreshExits(data, new Date(`${sessions[ti + 1]}T22:00:00Z`), nasdaq)).toBe(1);
    const acmeTrack = (await allTracks()).find((t) => t.scanId === by("ACME").id)!;
    expect(acmeTrack).toMatchObject({ nextKnown: true, nextReport: sessions[ti + 5], exitDate: sessions[ti + 4] });
    expect(acmeTrack.exitMoves[0].why).toBe("date confirmed on the calendar");

    // Past the exit: closed, with returns from the open and from the reaction-day close, and the exit basis.
    await updateEarningsTracks(data, new Date(`${sessions[ti + 6]}T23:00:00Z`));
    const done = (await allTracks()).find((t) => t.scanId === by("ACME").id)!;
    expect(done).toMatchObject({ closed: true, exitBasis: "confirmed next-report date" });
    expect(done.retPct).not.toBeNull();
    expect(done.retClosePct).not.toBeNull();
  });
});
