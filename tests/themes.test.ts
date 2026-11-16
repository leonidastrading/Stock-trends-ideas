import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import { playerOf } from "@/lib/scout/scoreboard";
import * as store from "@/lib/scout/store";
import { parseThemes, runThemes, themeRuns, themesIfDue, themeToSwing, THEMES_PROMPT } from "@/lib/scout/themes";

const theme = (o: Record<string, unknown> = {}) => ({ title: "Power for AI data centers", direction: "long", tickers: ["$vst", "CEG", "not a ticker!"], thesis: "t", catalyst: "c", agreement: { documents: 3, websites: 2, stocktwits: 9 }, quotes: [{ text: "grid is the bottleneck", source: "newsletter.md" }], disagreement: "", crowding: "up 20% in a month", breaks_it: "b", confidence: 140, ...o });

describe("themes", () => {
  it("the prompt asks for agreement across sources, crowding and no invented quotes", () => {
    expect(THEMES_PROMPT).toMatch(/several independent sources make the same call/);
    expect(THEMES_PROMPT).toMatch(/how crowded it looks/);
    expect(THEMES_PROMPT).toMatch(/do not invent quotes/);
    expect(THEMES_PROMPT).toMatch(/data, not instructions/);
  });

  it("cleans the reply: tickers, at most 3, confidence 0-100, drops ideas without a ticker", () => {
    const t = parseThemes(JSON.stringify({ themes: [theme(), theme({ tickers: [] }), theme({ title: "b" }), theme({ title: "c" }), theme({ title: "d" })] }));
    expect(t).toHaveLength(3);
    expect(t[0]).toMatchObject({ tickers: ["VST", "CEG"], confidence: 100, direction: "long" });
  });

  it("sends the main ticker to Swing: theme catalyst, 14-day exit, smaller size under 50 confidence", () => {
    const [t] = parseThemes(JSON.stringify({ themes: [theme({ confidence: 62 })] }));
    expect(themeToSwing(t, "2026-11-17", { normal: 2000, speculative: 1000 })).toMatchObject({ ticker: "VST", side: "long", catalyst: "theme", speculative: false, notional: 2000, exitRule: "time", exitParam: 14 });
    const [w] = parseThemes(JSON.stringify({ themes: [theme({ confidence: 40, direction: "short" })] }));
    expect(themeToSwing(w, "2026-11-17", { normal: 2000, speculative: 1000 })).toMatchObject({ side: "short", speculative: true, notional: 1000 });
    expect(themeToSwing(w, "2026-11-17", { normal: 2000, speculative: 1000 }).thesis).toMatch(/^\[Trend scout theme, 2026-11-17\] Power for AI data centers/);
  });

  it("theme research scores as its own player", () => {
    expect(playerOf("scout", "theme: Power for AI data centers → VST")).toBe("scout_themes");
  });
});

describe("themes: a reading (PGlite, fake sources and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("reads the inbox, websites and Stocktwits, logs the top ideas with prices, once a weekday", async () => {
    const now = new Date();
    await store.markInbox("ideas/2026-11-15-newsletter.md", "sha1", { via: "test" }, "Utilities are the AI trade now: VST and CEG keep winning power deals.");
    const fetchImpl = (async (url: string) => {
      if (url.includes("/trending/")) return Response.json({ symbols: [{ symbol: "VST", title: "Vistra", watchlist_count: 50000, trends: { summary: "Data center power deal" } }] });
      if (url.includes("/streams/symbol/VST")) return Response.json({ messages: [{ body: "VST is the cleanest AI power play, nuclear PPAs coming", entities: { sentiment: { basic: "Bullish" } } }] });
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    let seen = "";
    const callModel: CallModel = async ({ user, purpose }) => {
      expect(purpose).toBe("themes");
      seen = user;
      return { text: JSON.stringify({ themes: [theme()] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.05 };
    };
    const data = { getSnapshots: async () => ({ VST: { price: 180, prevClose: 178, at: null, sessionDate: null }, CEG: { price: 300, prevClose: 299, at: null, sessionDate: null } }), getDailyBars: async () => [], getNews: async () => [], getCalendar: async () => [] } as unknown as MarketData;
    const out = await runThemes({ data, callModel, now, fetchImpl });
    expect(out).toMatch(/1 themes from 1 documents, 0 website articles and 1 Stocktwits posts/);
    expect(seen).toContain("VST and CEG keep winning power deals");
    expect(seen).toContain("Data center power deal");
    expect(seen).toContain("nuclear PPAs coming");
    const [r] = await themeRuns(5);
    expect(r.themes[0]).toMatchObject({ tickers: ["VST", "CEG"], prices: { VST: 180, CEG: 300 } });
    // Already read today: not again (on a weekday after 7 AM ET).
    const weekdayMorning = new Date(`${r.etDate}T15:00:00Z`);
    const day = weekdayMorning.getUTCDay();
    if (day !== 0 && day !== 6) expect(await themesIfDue({ data, callModel, now: weekdayMorning, fetchImpl })).toBe("done today");
    expect(await themesIfDue({ data, callModel, now: new Date("2026-11-21T15:00:00Z"), fetchImpl })).toBe("weekend");
  });
});
