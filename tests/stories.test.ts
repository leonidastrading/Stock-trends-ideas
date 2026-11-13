import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData, NewsItem } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import { buildStoryPrompt, detectStories, parseStoryTriage, runStories, STORY_JSON_SCHEMA, storyTerm } from "@/lib/scout/stories";
import * as store from "@/lib/scout/store";
import { sampleCard } from "./card.test";

let id = 0;
const n = (headline: string, symbols: string[], main = true, summary = ""): NewsItem => ({ id: ++id, ts: "2026-11-13T10:00:00Z", headline, summary, symbols, source: main ? "reuters" : "wire", url: main ? "https://www.reuters.com/x" : "https://wire.example/x" });

describe("story detection", () => {
  it("finds a ticker story from shock wording with mainstream coverage, and a macro story from headlines with no ticker", () => {
    const items = [
      n("Nvidia board weighs ousting CEO Huang after scandal", ["NVDA"]), n("Nvidia CEO Jensen Huang under investigation", ["NVDA"]), n("Nvidia shares slide as board meets", ["NVDA"]), n("Analyst keeps Nvidia rating", ["NVDA"], false),
      n("Apple launches new iPad", ["AAPL"]), n("Apple iPad reviews", ["AAPL"]), n("Apple ships iPad", ["AAPL"]),
      ...Array.from({ length: 7 }, (_, i) => n(`Iran war: missile strikes hit oil facilities, day ${i}`, [])),
      n("Sector roundup", ["A", "B", "C", "D", "E", "F", "G"]),
    ];
    const s = detectStories(items);
    expect(s.map((x) => x.key)).toEqual(["macro:war", "NVDA"]);
    expect(s[1]).toMatchObject({ stories: 4, mainstream: 3, shockHits: 2 });
    expect(s[0].symbols).toEqual([]);
  });
  it("a coverage spike against the ticker's daily average counts even without shock words", () => {
    const items = Array.from({ length: 9 }, (_, i) => n(`Avis update ${i}`, ["CAR"], i < 4));
    expect(detectStories(items).map((x) => x.key)).toEqual([]);
    expect(detectStories(items, { dailyAvg: { CAR: 2 } }).map((x) => x.key)).toEqual(["CAR"]);
  });
  it("prompt, parse and schema", () => {
    const [s] = detectStories([n("Reddit traffic falls as Google AI answers more queries", ["RDDT"]), n("Reddit probe into traffic drop", ["RDDT"]), n("Reddit shares slide", ["RDDT"]), n("Reddit faces lawsuit over data", ["RDDT"])]);
    const p = buildStoryPrompt([s], "2026-11-13");
    expect(p).toMatch(/## RDDT — RDDT: 4 headlines, 4 mainstream/);
    expect(JSON.stringify(STORY_JSON_SCHEMA)).not.toMatch(/"(minItems|maxItems|minimum|maximum|pattern)":/);
    const t = parseStoryTriage(JSON.stringify({ stories: [{ key: "RDDT", summary: "s", skip: false, skip_reason: "", trades: [{ ticker: "rddt", direction: "short", role: "direct", horizon_days: 20, thesis: "t", why_not_priced: "w", invalidation: "i" }] }] }));
    expect(t.stories[0].trades[0].ticker).toBe("RDDT");
    expect(() => parseStoryTriage("[]")).toThrow(/validation/);
    const lenient = parseStoryTriage(JSON.stringify({ stories: [
      { key: "A", summary: "s", skip: false, skip_reason: "", trades: [{ ticker: "$brk-b", direction: "long", role: "direct", horizon_days: 5, thesis: "t", why_not_priced: "w", invalidation: "i" }, { ticker: "RDSA.AS", direction: "long", role: "second_order", horizon_days: 5, thesis: "t", why_not_priced: "w", invalidation: "i" }] },
      { key: "B", summary: "s", skip: false, skip_reason: "", trades: [{ ticker: "TSMC TAIWAN", direction: "long", role: "direct", horizon_days: 5, thesis: "t", why_not_priced: "w", invalidation: "i" }] },
    ] }));
    expect(lenient.stories[0].trades.map((t) => t.ticker)).toEqual(["BRK.B"]);
    expect(lenient.stories[1]).toMatchObject({ skip: true, skip_reason: /no US-listed ticker/ });
    expect(lenient.dropped).toEqual(["A: RDSA.AS", "B: TSMC TAIWAN"]);
    expect(storyTerm("RDDT", "GOOGL")).toBe("story: RDDT → GOOGL");
  });
});

describe("story desk end to end", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("detects, lays out trades, researches each as an event card, and does not repeat a story within 3 days", async () => {
    const items = [n("UnitedHealth CEO shot in Manhattan", ["UNH"]), n("UnitedHealth CEO killed; police investigate", ["UNH"]), n("UnitedHealth shares fall after CEO death", ["UNH"]), n("Insurers face scrutiny after UnitedHealth shooting", ["UNH", "CI", "ELV"])];
    const data: MarketData = {
      getNews: async (symbols) => (symbols.length ? [] : items),
      getDailyBars: async (symbols) => symbols.map((symbol) => ({ symbol, date: "2026-11-12", o: 100, h: 101, l: 99, c: 100, v: 1 })),
      getCalendar: async () => [],
    };
    const purposes: string[] = [];
    const callModel: CallModel = async ({ purpose, user }) => {
      purposes.push(purpose ?? "research");
      if (purpose === "stories") {
        expect(user).toMatch(/## UNH/);
        return { text: JSON.stringify({ stories: [{ key: "UNH", summary: "CEO killed; policy scrutiny likely", skip: false, skip_reason: "", trades: [
          { ticker: "UNH", direction: "short", role: "direct", horizon_days: 30, thesis: "scrutiny", why_not_priced: "slow burn", invalidation: "no policy response" },
          { ticker: "CI", direction: "short", role: "second_order", horizon_days: 30, thesis: "sector read-across", why_not_priced: "not in headlines", invalidation: "no spillover" },
        ] }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
      }
      expect(user).toMatch(/Story desk context/);
      const ticker = /trade \(\w+\): short (\w+)/.exec(user)![1];
      const t = sampleCard().tickers[0];
      return { text: JSON.stringify(sampleCard({ kind: "event", direction: "short", title: `${ticker} after the shooting`, tickers: [{ ...t, symbol: ticker, sector: "health_care" }] })), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.02 };
    };
    const deps = { data, sources: [], callModel, now: new Date("2026-11-13T12:00:00Z"), env: {} as NodeJS.ProcessEnv };
    const r = await runStories(deps);
    expect(r.headlinesRead).toBe(4);
    expect(r.detected.map((d) => d.key)).toEqual(["UNH"]);
    expect(r.researched.map((x) => x.outcome)).toEqual(["card: promoted", "card: promoted"]);
    expect(purposes).toEqual(["stories", "research", "research"]);
    const cards = await store.allCards();
    expect(cards.map((c) => [c.kind, c.direction, c.primaryTicker])).toEqual([["event", "short", "UNH"], ["event", "short", "CI"]]);
    expect((await store.getTrack(cards[1].id))?.sectorEtf).toBe("XLV");
    expect((await store.tickerDailyAverages("2026-11-01", "2026-11-14"))).toEqual({}); // needs 5 days of history first

    const again = await runStories(deps);
    expect(again.error).toMatch(/researched in the last 3 days/);
    expect(purposes).toHaveLength(3);
  });
});

describe("private-company liquidity events", () => {
  it("an IPO filing about a private company is a story even with no ticker and modest volume, and discovery lists it", async () => {
    const { summarizeNews } = await import("@/lib/scout/discovery");
    const items = [
      n("Anthropic files publicly for IPO, sets price range", []), n("Anthropic IPO: what the S-1 shows", []), n("Small biotech prices $20 million offering", [], false),
      n("Zoom shares jump as Anthropic files to go public", ["ZM"]),
    ];
    const s = detectStories(items);
    expect(s.map((x) => x.key)).toContain("macro:ipo");
    expect(s.find((x) => x.key === "macro:ipo")!.headlines.map((h) => h.headline)).toContain("Anthropic files publicly for IPO, sets price range");
    expect(summarizeNews(items).deals.map((d) => d.headline)).toEqual(expect.arrayContaining(["Anthropic IPO: what the S-1 shows", "Zoom shares jump as Anthropic files to go public"]));
  });
});

describe("story freshness", () => {
  it("lists the freshest story first and headlines newest first, with full timestamps", () => {
    const at = (h: string, ts: string, symbols: string[]) => ({ ...n(h, symbols), ts });
    const items = [
      at("Old: Nvidia CEO ousted", "2026-11-13T08:00:00Z", ["NVDA"]), at("Old: Nvidia probe", "2026-11-13T09:00:00Z", ["NVDA"]), at("Old: Nvidia scandal", "2026-11-13T09:30:00Z", ["NVDA"]),
      at("Microsoft outage hits Teams", "2026-11-13T14:00:00Z", ["MSFT"]), at("Microsoft outage spreads", "2026-11-13T15:00:00Z", ["MSFT"]), at("Microsoft probe of outage", "2026-11-13T16:30:00Z", ["MSFT"]),
    ];
    const s = detectStories(items);
    expect(s.map((x) => x.key)).toEqual(["MSFT", "NVDA"]);
    expect(s[0].latest).toBe("2026-11-13T16:30:00Z");
    expect(s[0].headlines[0].headline).toBe("Microsoft probe of outage");
    expect(buildStoryPrompt(s, "2026-11-13")).toMatch(/- 16:30Z \[reuters · MSFT\] Microsoft probe of outage/);
  });
  it("formats ET timestamps", async () => {
    const { fmtEt } = await import("@/lib/time");
    expect(fmtEt("2026-11-13T19:14:00Z")).toBe("Nov 13, 2:14 PM ET");
    expect(fmtEt("nonsense")).toBe("");
  });
});
