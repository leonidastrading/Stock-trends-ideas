import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData, NewsItem } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { buildTriagePrompt, parseTriage, summarizeNews, TRIAGE_JSON_SCHEMA, type Pulse } from "@/lib/scout/discovery";
import type { CallModel } from "@/lib/scout/llm";
import { runScan } from "@/lib/scout/scan";
import * as store from "@/lib/scout/store";
import { sampleCard } from "./card.test";

const n = (id: number, headline: string, symbols: string[], url = "https://wire.example/x", summary = ""): NewsItem => ({ id, ts: "2026-11-12T10:00:00Z", headline, summary, symbols, source: "wire", url });

describe("discovery, pure parts", () => {
  it("summarizes a day's headlines by ticker and pulls out supply/demand wording", () => {
    const items = [
      n(1, "Nvidia slides on CEO report", ["NVDA"], "https://www.reuters.com/a"), n(2, "Nvidia board meets", ["NVDA"]), n(3, "AMD gains", ["AMD"]),
      n(4, "Vertiv raises guidance on record data center orders", ["VRT"]), n(5, "Sector roundup", ["A", "B", "C", "D", "E", "F", "G"]), n(6, "Utility signs multi-year supply agreement for transformers", ["HUBB", "ETN"]),
    ];
    const s = summarizeNews(items);
    expect(s.headlinesRead).toBe(6);
    expect(s.topTickers[0]).toMatchObject({ symbol: "NVDA", stories: 2, mainstream: 1 });
    expect(s.supplyDemand.map((h) => h.headline)).toEqual(["Vertiv raises guidance on record data center orders", "Utility signs multi-year supply agreement for transformers"]);
  });
  it("builds the triage prompt and parses the reply; the schema avoids unsupported keywords", () => {
    const pulse: Pulse = { date: "2026-11-12", headlinesRead: 2, topTickers: [{ symbol: "NVDA", stories: 2, mainstream: 1, headlines: ["x"] }], supplyDemand: [], stocktwits: [{ symbol: "AMD", rank: 1, watchers: 10, why: "why" }], polymarket: [{ question: "Rate cut?", yes: 70, weekChange: 15, endDate: "2026-12-10" }], hackerNews: ["hn"], risingQueries: [{ title: "q", traffic: "200K+" }], problems: ["edgar: down"] };
    const p = buildTriagePrompt(pulse, 3, ["fed rate cut"]);
    expect(p).toMatch(/at most 3 candidates/);
    expect(p).toMatch(/do not propose again\): fed rate cut/);
    expect(p).toMatch(/#1 AMD \(10 watchers\): why/);
    expect(p).toMatch(/\+15 pts in 7d/);
    expect(JSON.stringify(TRIAGE_JSON_SCHEMA)).not.toMatch(/"(minItems|maxItems|minimum|maximum|pattern)":/);
    const t = parseTriage(JSON.stringify({ candidates: [{ term: "grid transformer backlog", kind: "second_order", tickers: ["hubb"], why: "w", seen_in: ["news"] }], read: "quiet" }));
    expect(t.candidates[0].tickers).toEqual(["HUBB"]);
    expect(() => parseTriage("{}")).toThrow(/validation/);
    const lenient = parseTriage(JSON.stringify({ candidates: [{ term: "retail brokers", kind: "platform", tickers: ["$hood", "NOT A TICKER"], why: "w", seen_in: [] }, { term: "toyota", kind: "platform", tickers: ["7203.T"], why: "w", seen_in: [] }], read: "r" }));
    expect(lenient.candidates).toHaveLength(1);
    expect(lenient.candidates[0].tickers).toEqual(["HOOD"]);
  });
});

describe("discovery inside the scan", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("reads the news, proposes a candidate, researches it, and proposes it for the watch-list", async () => {
    const data: MarketData = {
      getNews: async (symbols) => (symbols.length ? [] : [n(1, "Utility signs multi-year supply agreement for transformers", ["HUBB"]), n(2, "Nvidia slides", ["NVDA"], "https://www.reuters.com/a")]),
      getDailyBars: async (symbols) => symbols.map((symbol) => ({ symbol, date: "2026-11-11", o: 100, h: 101, l: 99, c: 100, v: 1 })),
      getCalendar: async () => [],
    };
    const purposes: string[] = [];
    const callModel: CallModel = async ({ purpose, user }) => {
      purposes.push(purpose ?? "research");
      const text = purpose === "triage"
        ? JSON.stringify({ candidates: [{ term: "transformer supply agreements", kind: "second_order", tickers: ["HUBB", "ETN"], why: "a utility signed a multi-year supply deal", seen_in: ["news"] }], read: "Chips dominated; grid gear moved quietly." })
        : JSON.stringify(sampleCard({ title: "Transformer supply deals tighten" }));
      if (purpose === "research") expect(user).toMatch(/a utility signed a multi-year supply deal/);
      return { text, stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const source = { id: "edgar", label: "", about: "", configured: () => true, probe: async () => ({ source: "edgar", status: "ok" as const, signals: [{ source: "edgar", metric: "filings_30d", value: 4, baseline: 1, changeVs12m: 3, asOf: "2026-11-12", note: "4 filings" }] }) };
    const fetchImpl: typeof fetch = (async () => new Response("down", { status: 503 })) as typeof fetch; // trending lists unavailable: reported, not fatal
    await store.saveSettings({ ...(await store.loadSettings()), maxCandidatesPerScan: 0, discoveryPerScan: 2 });
    const report = await runScan({ data, sources: [source], callModel, now: new Date("2026-11-12T12:00:00Z"), env: {} as NodeJS.ProcessEnv, fetchImpl });
    expect(report.discovery?.headlinesRead).toBe(2);
    expect(report.discovery?.read).toMatch(/grid gear/);
    expect(report.discovery?.problems.join()).toMatch(/stocktwits/);
    expect(report.researched).toEqual([{ term: "transformer supply agreements", outcome: "card: promoted", cardId: 1 }]);
    expect(purposes).toEqual(["triage", "research"]);
    expect((await store.watchlist("proposed")).map((w) => w.term)).toContain("transformer supply agreements");
    expect((await store.candidatesSince(1))[0].trigger?.[0]).toMatchObject({ source: "discovery" });
  });
});
