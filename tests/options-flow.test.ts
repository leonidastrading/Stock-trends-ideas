import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPTIONS_UNIVERSE } from "@/config/options";
import { setQuerierForTests } from "@/lib/db";
import { clearHttpCache } from "@/lib/http";
import { pickSignals } from "@/lib/scout/filings";
import { compact, daySummary, describeFlag, diffChain, flagChanges, runOptionsLog } from "@/lib/scout/options-flow";
import * as store from "@/lib/scout/store";
import { parseChain, type Chain } from "@/lib/sources/cboe-options";

// Cboe's delayed chain as served on 2026-11-14 (NVDA, Jan 15 2027 puts; figures from that day's file).
const row = (option: string, oi: number, bid: number, ask: number, volume = 0) => ({ option, bid, ask, open_interest: oi, volume, iv: 0.6, last_trade_price: (bid + ask) / 2 });
const cboe = (lastTrade: string, rows: unknown[], price = 161.01) => ({ timestamp: "2026-11-14 22:24:14", symbol: "NVDA", data: { symbol: "NVDA", current_price: price, last_trade_time: lastTrade, options: rows } });

describe("Cboe chain", () => {
  it("parses standard contracts and skips adjusted roots", () => {
    const c = parseChain(cboe("2026-11-13T15:59:59", [row("NVDA270115P00150000", 183265, 7.9, 8.15, 11828), row("B1VDA261120C00150000", 0, 0.59, 0.89), row("NVDA261218C00185000", 115487, 2, 2.1)]), "NVDA")!;
    expect(c).toMatchObject({ symbol: "NVDA", spot: 161.01, asOf: "2026-11-13" });
    expect(c.contracts).toEqual([
      { contract: "NVDA270115P00150000", type: "put", strike: 150, expiry: "2027-01-15", oi: 183265, volume: 11828, mid: 8.025 },
      { contract: "NVDA261218C00185000", type: "call", strike: 185, expiry: "2026-12-18", oi: 115487, volume: 0, mid: 2.05 },
    ]);
    expect(parseChain({ data: {} }, "NVDA")).toBeNull();
  });
});

const chain = (contracts: Array<[string, number, number]>, spot = 161.01): Chain => ({
  symbol: "NVDA", spot, asOf: "2026-11-13",
  contracts: contracts.map(([contract, oi, mid]) => {
    const m = contract.match(/^NVDA(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)!;
    return { contract, type: m[4] === "C" ? "call" : "put", strike: Number(m[5]) / 1000, expiry: `20${m[1]}-${m[2]}-${m[3]}`, oi, volume: 0, mid };
  }),
});

describe("flags", () => {
  // The reported trade: 180,000 $150 puts and 280,000 $100 puts opened the same day, Jan 2027 expiry.
  const prev = { NVDA270115P00150000: 3265, NVDA270115P00100000: 0, NVDA270115P00140000: 58000, NVDA261218C00185000: 100000, NVDA261120P00170000: 1000 };
  const now = chain([["NVDA270115P00150000", 183265, 8.025], ["NVDA270115P00100000", 280000, 0.68], ["NVDA270115P00140000", 58092, 4.97], ["NVDA261218C00185000", 115487, 2.05], ["NVDA261120P00170000", 90000, 9.5]]);

  it("flags the NVDA put ratio spread, without a baseline, and names the structure", () => {
    const changes = diffChain(prev, now);
    const f = flagChanges(changes, now, "2026-11-13", { median: null, n: 0 });
    expect(f.map((x) => x.contract)).toEqual(["NVDA270115P00150000", "NVDA270115P00100000"]); // largest premium first
    expect(f[0]).toMatchObject({ prevOi: 3265, oi: 183265, premiumUsd: 144450000, multiple: null, structure: "ratio spread: 180k at $150 against 280k at $100 (1×1.6)" });
    expect(f[1].structure).toBe(f[0].structure);
    // The $170 put is in the money (stock $161) and the call change is below the no-baseline bar: neither is flagged.
    expect(describeFlag(f[0])).toMatch(/^NVDA 2027-01-15 \$150 puts: \+180,000 contracts open \(3,265 → 183,265\), about \$144\.4M of premium, \$2\.9B of stock at \$161\.01, no normal yet; ratio spread/);
  });

  it("with a baseline: flags what is many times the stock's normal, ignores what is not", () => {
    const changes = diffChain(prev, now);
    const quiet = flagChanges(changes, now, "2026-11-13", { median: 50_000, n: 10 }); // 180k / 50k = 3.6×: not unusual for this stock
    expect(quiet.map((x) => x.contract)).toEqual(["NVDA270115P00100000"]); // 280k / 50k = 5.6×
    const normal = flagChanges(changes, now, "2026-11-13", { median: 3000, n: 10 });
    expect(normal.find((x) => x.contract === "NVDA261218C00185000")).toMatchObject({ multiple: 5.2, premiumUsd: 3174835 }); // +15,487 calls, 5.2× normal, $3.2M
  });

  it("day summary: the 95th percentile and largest increase", () => {
    const changes = diffChain(prev, now);
    expect(daySummary("NVDA", "2026-11-13", "2026-11-12", now, changes)).toMatchObject({ contracts: 5, callOi: 115487, maxUp: 280000, prevDate: "2026-11-12" });
    expect(compact(chain([["NVDA270115P00150000", 5, 1], ["NVDA270115P00100000", 10, 1]]))).toEqual({ NVDA270115P00100000: 10 });
  });

  it("feeds the research desk as a short idea for puts", () => {
    const f = flagChanges(diffChain(prev, now), now, "2026-11-13", { median: null, n: 0 });
    const s = pickSignals([], [], "2026-11-14", f);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "options", symbol: "NVDA", term: "options: NVDA puts 2027-01-15", direction: "short", strength: 2.5 });
    expect(s[0].context).toMatch(/side is unknown/);
    expect(s[0].context.match(/^- NVDA/gm)).toHaveLength(2);
  });
});

describe("daily log (PGlite, fake Cboe)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("captures once a trading day, compares with the previous capture, stores flags; outside hours and weekends do nothing", async () => {
    let day = "2026-11-12";
    let puts = 3265;
    const fake = (async (url: string) => {
      const sym = decodeURIComponent(String(url).split("/").pop()!.replace(".json", ""));
      const rows = sym === "NVDA" ? [row("NVDA270115P00150000", puts, 7.9, 8.15)] : [row(`${sym}270115C00100000`, 10, 1, 1.1)];
      return new Response(JSON.stringify({ ...cboe(`${day}T11:00:00`, rows), symbol: sym, data: { ...cboe(`${day}T11:00:00`, rows).data, symbol: sym } }), { status: 200 });
    }) as unknown as typeof fetch;
    const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00-05:00`);

    expect(await runOptionsLog(Date.now() + 60_000, at("2026-11-14", "11:00"), fake)).toBe("weekend");
    expect(await runOptionsLog(Date.now() + 60_000, at("2026-11-12", "09:30"), fake)).toMatch(/outside/);

    clearHttpCache();
    const first = await runOptionsLog(Date.now() + 60_000, at("2026-11-12", "11:00"), fake);
    expect(first).toMatchObject({ captured: OPTIONS_UNIVERSE.length, flagged: 0, left: 0 });
    expect(await runOptionsLog(Date.now() + 60_000, at("2026-11-12", "12:00"), fake)).toMatchObject({ captured: 0 }); // once a day

    day = "2026-11-13";
    puts = 183265;
    clearHttpCache();
    const second = await runOptionsLog(Date.now() + 60_000, at("2026-11-13", "11:00"), fake);
    expect(second).toMatchObject({ captured: OPTIONS_UNIVERSE.length, flagged: 1 });
    const flags = await store.optionsFlagsSince("2026-11-01");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ symbol: "NVDA", prevOi: 3265, oi: 183265, date: "2026-11-13" });
    expect(await store.optionsLogStatus()).toMatchObject({ stocks: OPTIONS_UNIVERSE.length, latest: "2026-11-13", days: 1 });
    await expect(pg.query("DELETE FROM options_flags")).rejects.toThrow(/append-only/);
  });
});
