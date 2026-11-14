import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHATTER, CHATTER_UNIVERSE } from "@/config/chatter";
import type { DailyBar } from "@/lib/alpaca";
import { query, setQuerierForTests } from "@/lib/db";
import { chatterReport, eventOutcome, groupOf, isControlDay, nearEarnings, runChatterBatch, spikeScore, stat } from "@/lib/scout/chatter";
import { cleanSeries, exploreEvents } from "@/lib/scout/chatter-explore";
import * as store from "@/lib/scout/store";
import { addDays } from "@/lib/time";

const b = (symbol: string, date: string, o: number, c = o): DailyBar => ({ symbol, date, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) out.push(d);
  return out;
};

describe("chatter test: the rules", () => {
  it("universe: 198 stocks, 18 per sector, fixed in advance", () => {
    expect(CHATTER_UNIVERSE).toHaveLength(198);
    expect(new Set(CHATTER_UNIVERSE.map((u) => u.symbol)).size).toBe(198);
    expect(CHATTER_UNIVERSE.find((u) => u.symbol === "XOM")?.etf).toBe("XLE");
  });

  it("spike score uses only earlier days, on a log scale", () => {
    const hist = Array.from({ length: 30 }, (_, i) => 10 + (i % 3)); // ~10-12 per hour
    expect(spikeScore(hist.slice(0, 10), 50)).toBeNull(); // too little history
    expect(spikeScore(hist, 50)!.z).toBeGreaterThan(CHATTER.spikeZ);
    expect(spikeScore(hist, 11)!.z).toBeLessThan(1);
    expect(spikeScore(hist, 50)!.baseline).toBeGreaterThan(9);
    expect(spikeScore(hist, 50, { log: false })!.z).toBeGreaterThan(spikeScore(hist, 50)!.z); // raw scale for the 0-100 history
  });

  it("controls: deterministic, about 1 in 40", () => {
    expect(isControlDay("2026-11-16", "AAPL")).toBe(isControlDay("2026-11-16", "AAPL"));
    const days = weekdays("2026-01-05", 200);
    const n = CHATTER_UNIVERSE.reduce((a, u) => a + days.filter((d) => isControlDay(d, u.symbol)).length, 0);
    expect(n / (days.length * CHATTER_UNIVERSE.length)).toBeGreaterThan(0.018);
    expect(n / (days.length * CHATTER_UNIVERSE.length)).toBeLessThan(0.032);
  });

  it("outcome: entry at the next open, excess over SPY and sector after N sessions, prior 5-session move", () => {
    const d = weekdays("2026-11-02", 25);
    const sym = d.map((x, i) => b("X", x, 100 + i, 100 + i)); // +1/day
    const spy = d.map((x) => b("SPY", x, 600, 600));
    const etf = d.map((x, i) => b("XLK", x, 50 + i * 0.25, 50 + i * 0.25));
    const o = eventOutcome(d[6], sym, spy, etf, [1, 5, 20])!;
    expect(o.entryDate).toBe(d[7]);
    expect(o.excess[1]).toBeCloseTo(0, 6); // open 107 → close 107
    expect(o.excess[5]).toBeCloseTo(111 / 107 - 1, 6);
    expect(o.excess[20]).toBeNull(); // entry is session 8 of 25: no 20th session yet
    expect(o.prior5Excess).toBeCloseTo(105 / 100 - 1, 6);
    expect(o.quiet).toBe(false); // +5% in 5 sessions: chatter following the price
    const flat = d.map((x) => b("Y", x, 100, 100));
    expect(eventOutcome(d[6], flat, spy, etf)!.quiet).toBe(true);
    expect(eventOutcome(d[24], flat, spy, etf)).toBeNull(); // no session after
  });

  it("groups and report", () => {
    expect(groupOf("spike", 0.8, true)).toBe("quiet_bullish");
    expect(groupOf("spike", 0.2, true)).toBe("quiet_bearish");
    expect(groupOf("spike", null, true)).toBe("quiet_mixed");
    expect(groupOf("spike", 0.8, false)).toBe("after_move");
    expect(groupOf("control", 0.8, false)).toBe("control");
    expect(groupOf("spike", 0.8, null)).toBeNull();
    expect(groupOf("spike", 0.8, true, true)).toBe("earnings");
    expect(groupOf("control", 0.8, true, true)).toBe("control");
    expect(nearEarnings("2026-10-30", ["2026-10-29"])).toBe(true); // MSFT-style: chatter the day after results
    expect(nearEarnings("2026-11-05", ["2026-10-29"])).toBe(false);
    expect(nearEarnings("2026-11-05", undefined)).toBe(false);
    expect(stat([0.02, -0.01, null, 0.04])).toMatchObject({ n: 3, hit: 2 / 3, median: 0.02 });
    const out = (x: number, quiet: boolean) => ({ entryDate: "d", prior5Excess: 0, quiet, excess: { 1: x, 5: x, 20: null }, excessSector: { 1: x, 5: x, 20: null } });
    const r = chatterReport([{ kind: "spike", bullishShare: 0.9, outcome: out(0.03, true) }, { kind: "spike", bullishShare: 0.9, outcome: out(-0.01, true) }, { kind: "control", bullishShare: null, outcome: out(0.001, true) }, { kind: "spike", bullishShare: 0.9, outcome: null }]);
    expect(r.find((x) => x.group === "quiet_bullish")).toMatchObject({ events: 2 });
    expect(r.find((x) => x.group === "quiet_bullish")!.byHorizon[5].mean).toBeCloseTo(0.01, 6);
    expect(r.find((x) => x.group === "quiet_bullish")!.byHorizon[20].n).toBe(0);
    expect(r.find((x) => x.group === "control")!.events).toBe(1);
    const e = chatterReport([{ kind: "spike", bullishShare: 0.9, outcome: out(0.05, true), nearEarnings: true }]);
    expect(e.find((x) => x.group === "earnings")!.events).toBe(1);
    expect(e.find((x) => x.group === "quiet_bullish")!.events).toBe(0);
  });

  it("look-back: spikes on the 0-100 score judged on earlier points only, once per episode", () => {
    const d = weekdays("2026-08-13", 40);
    const pts = d.map((x, i): [string, number] => [x, i === 30 || i === 31 || i === 38 ? 95 : 40 + (i % 3)]);
    const ev = exploreEvents({ AAPL: pts }).filter((e) => e.kind === "spike");
    expect(ev.map((e) => e.date)).toEqual([d[30], d[38]]); // day 31 is the same episode
  });

  it("look-back: drops histories that stop early or were dark then remapped", () => {
    const d = weekdays("2026-08-13", 66);
    const ok = d.map((x): [string, number] => [x, 50]);
    const para = d.map((x, i): [string, number] => [x, i < 59 ? 0 : 95]);
    const r = cleanSeries({ AAPL: ok, EA: ok.slice(0, 2), WBD: ok.slice(0, 39), PARA: para, IPG: [] });
    expect(Object.keys(r.kept)).toEqual(["AAPL"]);
    expect(r.dropped).toEqual(["EA", "IPG", "PARA", "WBD"]);
  });
});

describe("chatter test: a batch (PGlite, fake Stocktwits)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  const now = new Date("2026-11-17T15:00:00Z"); // Tuesday 10:00 ET
  const msgs = (n: number, spanHours: number, bullish: number) => Array.from({ length: n }, (_, i) => ({ id: i, created_at: new Date(now.getTime() - (spanHours * 3600000 * i) / (n - 1)).toISOString(), entities: { sentiment: { basic: i < bullish ? "Bullish" : "Bearish" } } }));
  const fake = (spike: Set<string>) => (async (url: string) => {
    if (url.includes("trending")) return new Response(JSON.stringify({ symbols: [{ symbol: "AAPL", trending_score: 9 }] }));
    const sym = decodeURIComponent(/symbol\/([^.]+(?:\.[A-Z])?)\.json/.exec(url)![1]);
    return new Response(JSON.stringify({ symbol: { watchlist_count: 1000 }, messages: spike.has(sym) ? msgs(30, 0.5, 25) : msgs(30, 10, 15) }));
  }) as unknown as typeof fetch;

  it("measures in fixed batches once a day, logs a spike against the stock's own history, skips weekends", async () => {
    // 25 earlier weekdays of ordinary chatter (~3 per hour) for the first batch.
    for (const d of weekdays("2026-10-13", 25)) for (const u of CHATTER_UNIVERSE.slice(0, 5)) await store.addChatterDay({ date: d, symbol: u.symbol, perHour: 2.8 + (d.charCodeAt(9) % 3) * 0.2, sampled: 30, spanHours: 10, bullishShare: 0.5, watchers: 1000, trendingRank: null });
    const r1 = await runChatterBatch(now, fake(new Set(["AAPL"])), 5);
    expect(r1).toMatchObject({ measured: 5, remaining: 193, spikes: ["AAPL"] });
    const ev = await store.chatterEvents();
    expect(ev.filter((e) => e.kind === "spike")).toEqual([expect.objectContaining({ symbol: "AAPL", date: "2026-11-17", bullishShare: 0.83 })]);
    expect(ev[0].z).toBeGreaterThan(CHATTER.spikeZ);
    const r2 = await runChatterBatch(now, fake(new Set()), 5);
    expect(r2.measured).toBe(5);
    expect((await store.chatterMeasuredOn("2026-11-17")).size).toBe(10); // the next five, not the same ones
    await expect(query(`UPDATE chatter_daily SET per_hour = 0`)).rejects.toThrow(); // append-only
    expect((await runChatterBatch(new Date("2026-11-21T15:00:00Z"), fake(new Set()), 5)).skipped).toBe("weekend");
    // The next day AAPL is still loud: same episode, no second spike.
    const r3 = await runChatterBatch(new Date("2026-11-18T15:00:00Z"), fake(new Set(["AAPL"])), 5);
    expect(r3.spikes).toEqual([]);
  });

  it("stops a batch on a rate limit and picks up next time", async () => {
    let calls = 0;
    const limited = (async (url: string) => {
      if (url.includes("trending")) return new Response("{}");
      return ++calls > 2 ? new Response("rate", { status: 429 }) : new Response(JSON.stringify({ messages: msgs(30, 10, 15) }));
    }) as unknown as typeof fetch;
    const r = await runChatterBatch(new Date("2026-11-19T15:00:00Z"), limited, 10);
    expect(r.measured).toBe(2);
    expect(r.errors.at(-1)).toMatch(/429/);
  });
});

describe("earnings dates from SEC filings", () => {
  it("picks 8-K item 2.02 releases", async () => {
    const { earningsDates } = await import("@/lib/sources/edgar");
    const subs = { cik: "1", filings: { recent: { accessionNumber: ["a", "b", "c", "d"], filingDate: ["2026-10-29", "2026-09-02", "2026-07-30", "2026-04-28"], form: ["8-K", "8-K", "8-K/A", "8-K"], items: ["2.02,9.01", "5.02", "2.02", "2.02"], primaryDocument: ["x", "x", "x", "x"] } } };
    expect(earningsDates(subs, "2026-07-20")).toEqual(["2026-07-30", "2026-10-29"]);
  });
});
