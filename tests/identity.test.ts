import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Asset, DailyBar, MarketData } from "@/lib/alpaca";
import { assertReadOnlyEndpoint, PAPER_TRADING_HOST, TRADING_HOST } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { checkTicker, namesMatch, notCommon } from "@/lib/scout/identity";
import { loadIdeas } from "@/lib/scout/ideas-load";
import { verifyTickers } from "@/lib/scout/research";
import * as store from "@/lib/scout/store";
import { updateTracks } from "@/lib/scout/tracking";
import { sampleCard } from "./card.test";

const asset = (symbol: string, name: string, tradable = true): Asset => ({ symbol, name, exchange: "NASDAQ", active: true, tradable });
const SEC = [
  { cik: "1415404", ticker: "ECHO", title: "EchoStar CORP" },
  { cik: "1920406", ticker: "ASST", title: "Strive, Inc." },
  { cik: "1652044", ticker: "GOOGL", title: "Alphabet Inc." },
  { cik: "1652044", ticker: "GOOG", title: "Alphabet Inc." },
];
const ASSETS: Record<string, Asset> = {
  SATS: asset("SATS", "Strive, Inc. 15% Series A Perpetual SATS Preferred Stock"),
  ECHO: asset("ECHO", "EchoStar Corporation Class A Common Stock"),
  GOOGL: asset("GOOGL", "Alphabet Inc. Class A Common Stock"),
  USO: asset("USO", "United States Oil Fund, LP"),
};

describe("ticker identity (the SATS lesson)", () => {
  it("names and security types", () => {
    expect(namesMatch("EchoStar", "EchoStar Corporation Class A Common Stock")).toBe(true);
    expect(namesMatch("EchoStar Corporation", "Strive, Inc. 15% Series A Perpetual SATS Preferred Stock")).toBe(false);
    expect(namesMatch("Alphabet", "Alphabet Inc. Class A Common Stock")).toBe(true);
    expect(namesMatch("Taiwan Semiconductor Manufacturing", "Taiwan Semiconductor Manufacturing Company Ltd. American Depositary Shares")).toBe(true);
    expect(notCommon("Strive, Inc. 15% Series A Perpetual SATS Preferred Stock")).toBe("perpetual");
    expect(notCommon("United States Oil Fund, LP")).toBeNull();
    expect(notCommon("Taiwan Semiconductor Manufacturing Company Ltd. American Depositary Shares")).toBeNull();
  });

  it("SATS for EchoStar is corrected to ECHO", () => {
    const c = checkTicker("SATS", "EchoStar Corporation", ASSETS.SATS, SEC);
    expect(c).toMatchObject({ action: "corrected", to: "ECHO" });
    expect(c.note).toMatch(/SATS → ECHO: SATS now trades as "Strive, Inc\. 15% Series A Perpetual SATS Preferred Stock"/);
  });
  it("without the SEC list, a preferred is still dropped", () => {
    expect(checkTicker("SATS", "EchoStar Corporation", ASSETS.SATS, null)).toMatchObject({ action: "dropped" });
  });
  it("ok, unconfirmed and unknown symbols", () => {
    expect(checkTicker("GOOGL", "Alphabet", ASSETS.GOOGL, SEC).action).toBe("ok");
    expect(checkTicker("GOOGL", "Google", ASSETS.GOOGL, SEC)).toMatchObject({ action: "unconfirmed" }); // kept, with a note
    expect(checkTicker("USO", "United States Oil Fund", ASSETS.USO, SEC).action).toBe("ok");
    expect(checkTicker("ZZZZ", "Nobody Corp", null, SEC)).toMatchObject({ action: "dropped", note: expect.stringMatching(/not a listed symbol/) });
    expect(checkTicker("AAPL", undefined as unknown as null, asset("AAPL", "Apple Inc. Common Stock"), SEC).action).toBe("ok"); // older cards: no company named
  });

  it("verifyTickers corrects the card before it is logged, and drops what cannot be fixed", async () => {
    const data = { getDailyBars: async () => [], getNews: async () => [], getCalendar: async () => [], getAsset: async (s: string) => ASSETS[s] ?? null } as MarketData;
    const sec = (async () => new Response(JSON.stringify(Object.fromEntries(SEC.map((e, i) => [i, { cik_str: Number(e.cik), ticker: e.ticker, title: e.title }]))))) as unknown as typeof fetch;
    const t = sampleCard().tickers[0];
    const card = sampleCard({ tickers: [{ ...t, symbol: "SATS", company: "EchoStar Corporation" }, { ...t, symbol: "ZZZZ", company: "Nobody" }, { ...t, symbol: "GOOGL", company: "Alphabet" }] });
    const r = await verifyTickers(card, { data, sources: [], callModel: null as never, now: new Date(), env: { SEC_USER_AGENT: "Test test@example.com" } as unknown as NodeJS.ProcessEnv, fetchImpl: sec });
    expect(r.card.tickers.map((x) => x.symbol)).toEqual(["ECHO", "GOOGL"]);
    expect(r.notes.join(" | ")).toMatch(/SATS → ECHO.*ZZZZ is not a listed symbol/);
    expect(r.noValidTicker).toBe(false);
    const none = await verifyTickers(sampleCard({ tickers: [{ ...t, symbol: "ZZZZ", company: "Nobody" }] }), { data, sources: [], callModel: null as never, now: new Date(), env: {} as NodeJS.ProcessEnv });
    expect(none.noValidTicker).toBe(true);
  });

  it("asset lookups are read-only metadata; orders and positions stay forbidden", () => {
    expect(() => assertReadOnlyEndpoint(TRADING_HOST, "/v2/assets/SATS")).not.toThrow();
    expect(() => assertReadOnlyEndpoint(PAPER_TRADING_HOST, "/v2/assets/BRK.B")).not.toThrow();
    expect(() => assertReadOnlyEndpoint(TRADING_HOST, "/v2/assets")).toThrow(/read-only/);
    expect(() => assertReadOnlyEndpoint(TRADING_HOST, "/v2/orders")).toThrow(/read-only/);
  });
});

describe("excluding a track that followed the wrong security (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("the tracker excludes an open SATS track automatically; scoring leaves it out; the card is untouched", async () => {
    const v = await store.ensureVersion("h", "m", "high", {});
    const t = sampleCard().tickers[0];
    const mk = async (symbol: string) => {
      const c = await store.insertCard({ versionId: v.id, origin: "scout", card: sampleCard({ tickers: [{ ...t, symbol }] }), model: "m", modelServed: null, prompt: "", replyText: "", usage: null, costUsd: null, status: "promoted", gateNotes: [], catalystDate: null, rankScore: 15 });
      await store.insertTrack({ cardId: c.id, symbol, sectorEtf: "XLC", direction: "long", cardDate: "2026-11-05", deadlineDate: "2026-12-05" });
      return c;
    };
    const sats = await mk("SATS");
    const echo = await mk("ECHO");
    const days = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"];
    const bars = (symbols: readonly string[]): DailyBar[] => symbols.flatMap((symbol) => days.map((date, i) => ({ symbol, date, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 })));
    const data: MarketData = { getDailyBars: async (s) => bars(s), getNews: async () => [], getCalendar: async () => [], getAsset: async (s) => ASSETS[s] ?? null };
    const r = await updateTracks(data, new Date("2026-11-09T23:00:00Z"));
    expect(r.notes.join(" ")).toMatch(/card #1 excluded: SATS now trades as "Strive.*Preferred Stock", a perpetual security/);
    const tracks = await store.allTracks();
    expect(tracks.find((x) => x.cardId === sats.id)?.excluded).toMatch(/^automatic: SATS now trades as/);
    expect(tracks.find((x) => x.cardId === echo.id)?.excluded).toBeNull();
    const ideas = await loadIdeas(await store.allCards(), tracks);
    expect(ideas.map((i) => i.symbol)).toEqual(["ECHO"]);
    expect((await store.allCards()).find((c) => c.id === sats.id)?.primaryTicker).toBe("SATS"); // never edited
    await updateTracks(data, new Date("2026-11-10T23:00:00Z"));
    expect((await store.trackEvents()).filter((e) => e.kind === "excluded")).toHaveLength(1); // once
  });
});
