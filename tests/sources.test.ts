import { describe, expect, it } from "vitest";
import { findRank, resetAppChart, topFreeApps } from "@/lib/sources/appstore";
import { interestSummary } from "@/lib/sources/googletrends";
import { coverage, isMainstream } from "@/lib/sources/news";
import { marketOdds } from "@/lib/sources/polymarket";
import { wikipedia, pageviewSummary } from "@/lib/sources/wikipedia";
import { hackerNews } from "@/lib/sources/hackernews";
import { probeAll } from "@/lib/sources";

const fakeFetch = (routes: Record<string, unknown | (() => unknown)>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    const body = typeof v === "function" ? (v as () => unknown)() : v;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("pure source helpers", () => {
  it("wikipedia: 7-day vs 365-day average", () => {
    const series = Array.from({ length: 365 }, (_, i) => ({ date: `d${i}`, views: i >= 358 ? 200 : 100 }));
    const s = pageviewSummary(series)!;
    expect(s.v7).toBe(200);
    expect(s.v365).toBeCloseTo((358 * 100 + 7 * 200) / 365, 0);
    expect(pageviewSummary(series.slice(0, 5))).toBeNull();
  });
  it("google trends: last 4 weeks vs 12 months", () => {
    const pts = Array.from({ length: 52 }, (_, i) => ({ date: `w${i}`, value: i >= 48 ? 80 : 20 }));
    const s = interestSummary(pts)!;
    expect(s.v4).toBe(80);
    expect(s.peak).toBe(80);
  });
  it("polymarket: yes odds and weekly change in points", () => {
    expect(marketOdds({ question: "q", outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', oneWeekPriceChange: 0.12 })).toEqual({ yes: 62, weekChange: 12, dayChange: null });
    expect(marketOdds({ question: "q", outcomePrices: "bad" })).toBeNull();
  });
  it("app store: rank of the first matching app", () => {
    const r = findRank([{ name: "Foo", artistName: "A" }, { name: "Robinhood: Stocks", artistName: "Robinhood Markets" }], ["robinhood"]);
    expect(r).toEqual({ rank: 2, name: "Robinhood: Stocks", artist: "Robinhood Markets" });
    expect(findRank([], ["x"])).toBeNull();
  });
  it("app store: one shared download, iTunes fallback, failures not retried per term", async () => {
    resetAppChart();
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(new URL(url).host);
      if (url.includes("marketingtools")) return new Response("busy", { status: 404 });
      return new Response(JSON.stringify({ feed: { entry: [{ "im:name": { label: "Robinhood" }, "im:artist": { label: "Robinhood Markets" } }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([topFreeApps(fake, 1_000), topFreeApps(fake, 2_000)]);
    expect(a).toEqual([{ name: "Robinhood", artistName: "Robinhood Markets" }]);
    expect(b).toBe(a);
    expect(calls).toEqual(["rss.marketingtools.apple.com", "itunes.apple.com"]);
    resetAppChart();
    const down = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(topFreeApps(down, 0)).rejects.toThrow(/404/);
    await expect(topFreeApps(fake, 60_000)).rejects.toThrow(/404/); // remembered for 10 minutes
    expect((await topFreeApps(fake, 11 * 60_000)).length).toBe(1);
    resetAppChart();
  });
  it("news: mainstream detection and coverage counts", () => {
    const item = (url: string, source = "benzinga") => ({ id: 1, ts: "2026-11-10T00:00:00Z", headline: "h", summary: "", symbols: ["X"], source, url });
    expect(isMainstream(item("https://www.reuters.com/x"))).toBe(true);
    expect(isMainstream(item("https://smallblog.example/x", "smallblog"))).toBe(false);
    expect(coverage([item("https://www.reuters.com/a"), item("https://x.example/b", "x"), item("https://www.cnbc.com/c", "cnbc")])).toEqual({ stories: 3, mainstream: 2, sources: 3 });
  });
});

describe("probes against fake HTTP", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it("hacker news computes the weekly base and never throws on failure", async () => {
    const ok = fakeFetch({ "created_at_i>1793": { nbHits: 9, hits: [{ title: "t", points: 10, num_comments: 2, created_at: "2026-11-09T00:00:00Z" }] }, "created_at_i>1762": { nbHits: 104, hits: [] } });
    const r = await hackerNews.probe({ term: "x", kind: null, tickers: [], now, env: {} as NodeJS.ProcessEnv, fetchImpl: ok });
    expect(r.status).toBe("ok");
    expect(r.signals[0]).toMatchObject({ value: 9, baseline: 2, changeVs12m: 3.5 });
    const bad = await hackerNews.probe({ term: "y", kind: null, tickers: [], now, env: {} as NodeJS.ProcessEnv, fetchImpl: fakeFetch({}) });
    expect(bad.status).toBe("down");
    expect(bad.signals).toEqual([]);
  });
  it("wikipedia finds the article, then the pageviews", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ timestamp: `202609${String((i % 28) + 1).padStart(2, "0")}00`, views: i >= 53 ? 300 : 100 }));
    const f = fakeFetch({ "action=query": { query: { search: [{ title: "Data center" }] } }, "pageviews/per-article": { items } });
    const r = await wikipedia.probe({ term: "data center", kind: null, tickers: [], now, env: {} as NodeJS.ProcessEnv, fetchImpl: f });
    expect(r.status).toBe("ok");
    expect(r.signals[0].value).toBe(300);
    expect(r.signals[0].detail?.article).toBe("Data center");
  });
  it("probeAll marks unconfigured sources missing", async () => {
    const results = await probeAll([hackerNews, { id: "needs_key", label: "k", about: "", configured: () => false, probe: async () => { throw new Error("should not run"); } }], { term: "x", kind: null, tickers: [], now, env: {} as NodeJS.ProcessEnv, fetchImpl: fakeFetch({ "algolia": { nbHits: 0, hits: [] } }) });
    expect(results.map((r) => r.status)).toEqual(["ok", "missing"]);
  });
});
