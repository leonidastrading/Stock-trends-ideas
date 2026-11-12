import { describe, expect, it } from "vitest";
import { messageRate, stocktwits, trendingEntry, type StMessage } from "@/lib/sources/stocktwits";
import { acceleration, withHistory } from "@/lib/scout/scan";

const now = new Date("2026-11-12T12:00:00Z");
const msg = (hoursAgo: number, s?: string): StMessage => ({ id: Math.round(hoursAgo * 1000), created_at: new Date(now.getTime() - hoursAgo * 3600000).toISOString(), entities: s ? { sentiment: { basic: s } } : { sentiment: null } });

describe("stocktwits helpers", () => {
  it("message rate over the span of the latest messages, and the bullish share of tagged ones", () => {
    const r = messageRate([msg(0.5, "Bullish"), msg(1, "Bearish"), msg(2, "Bullish"), msg(3)], now)!;
    expect(r.spanHours).toBe(3);
    expect(r.perHour).toBeCloseTo(1.3, 1);
    expect(r.bullishShare).toBeCloseTo(0.67, 2);
    expect(messageRate([msg(1)], now)).toBeNull();
  });
  it("trending entry by rank", () => {
    const list = [{ symbol: "NVDA", trending_score: 90, watchlist_count: 680000, trends: { summary: " why " } }, { symbol: "AMD" }];
    expect(trendingEntry(list, "amd")).toEqual({ rank: 2, score: null, watchers: null, summary: null });
    expect(trendingEntry(list, "NVDA")).toMatchObject({ rank: 1, score: 90, summary: "why" });
    expect(trendingEntry(list, "XYZ")).toBeNull();
  });
});

describe("stocktwits probe", () => {
  const fake = (routes: Record<string, unknown>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response("nope", { status: 404 });
    }) as typeof fetch;
  it("measures each linked ticker and marks the rank metric lower-is-better in the scan", async () => {
    const f = fake({
      "trending/symbols/equities.json": { symbols: [{ symbol: "HOOD", trending_score: 42, watchlist_count: 300000 }] },
      "streams/symbol/HOOD.json": { symbol: { symbol: "HOOD", watchlist_count: 300123 }, messages: [msg(0.25, "Bullish"), msg(0.5), msg(1, "Bullish")] },
    });
    const r = await stocktwits.probe({ term: "prediction markets", kind: "platform", tickers: ["HOOD"], now, env: {} as NodeJS.ProcessEnv, fetchImpl: f });
    expect(r.status).toBe("ok");
    expect(r.signals.map((s) => s.metric)).toEqual(["messages_per_hour:HOOD", "watchers:HOOD", "trending_rank:HOOD"]);
    expect(r.signals[0].value).toBe(3);
    expect(r.signals[1].value).toBe(300123);
    const withBase = withHistory(r.signals, { "stocktwits:trending_rank:HOOD": { avg: 30, n: 40 }, "stocktwits:messages_per_hour:HOOD": { avg: 1, n: 40 } });
    expect(withBase[2].changeVs12m).toBeCloseTo(29); // rank 1 vs an average of 30: lower is better
    expect(withBase[0].changeVs12m).toBeCloseTo(2);
    expect(acceleration(withBase, "platform").accelerating).toHaveLength(1); // one signal per source counts once
  });
  it("no tickers = nothing to measure; a dead stream = down", async () => {
    expect((await stocktwits.probe({ term: "x", kind: null, tickers: [], now, env: {} as NodeJS.ProcessEnv, fetchImpl: fake({}) })).signals).toEqual([]);
    const r = await stocktwits.probe({ term: "x", kind: null, tickers: ["ZZZ"], now, env: {} as NodeJS.ProcessEnv, fetchImpl: fake({}) });
    expect(r.status).toBe("down");
  });
});
