import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/cards/[id]/route";
import { setQuerierForTests } from "@/lib/db";
import { bearerOk, cardForApi, compact, isCardApiRequest } from "@/lib/scout/card-api";
import * as store from "@/lib/scout/store";
import { sampleCard } from "./card.test";

const TOKEN = "t".repeat(43);

describe("card API (pure)", () => {
  it("lets only GET/HEAD /api/cards/<number> past the login", () => {
    expect(isCardApiRequest("/api/cards/246", "GET")).toBe(true);
    expect(isCardApiRequest("/api/cards/246", "HEAD")).toBe(true);
    expect(isCardApiRequest("/api/cards/246", "POST")).toBe(false);
    expect(isCardApiRequest("/api/cards/246/send", "GET")).toBe(false);
    expect(isCardApiRequest("/api/cards/abc", "GET")).toBe(false);
    expect(isCardApiRequest("/cards/246", "GET")).toBe(false);
  });

  it("accepts only the exact bearer token", () => {
    expect(bearerOk(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerOk(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerOk(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerOk(null, TOKEN)).toBe(false);
    expect(bearerOk("Basic dXNlcjpwYXNz", TOKEN)).toBe(false);
    expect(bearerOk(`Bearer ${TOKEN}`, undefined)).toBe(false); // no token configured: nothing gets in
    expect(bearerOk("Bearer short", "short")).toBe(false); // a weak token is refused
  });

  it("leaves out what a card does not have", () => {
    expect(compact({ a: 1, b: null, c: "", d: [], e: {}, f: { g: undefined }, h: [null, 2] })).toEqual({ a: 1, h: [2] });
  });
});

describe("GET /api/cards/[id] (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    process.env.SCOUT_API_TOKEN = TOKEN;
  });
  afterAll(() => { setQuerierForTests(null); delete process.env.SCOUT_API_TOKEN; });
  const call = (id: string, auth?: string) => GET(new Request(`https://scout.example/api/cards/${id}`, { headers: auth ? { authorization: auth } : {} }), { params: Promise.resolve({ id }) });

  it("401 without or with a wrong token, 404 for no card, the card with the token", async () => {
    const v = await store.ensureVersion("h", "m", "high", {});
    const c = await store.insertCard({ versionId: v.id, origin: "scout", card: sampleCard(), model: "m", modelServed: null, prompt: "", replyText: "", usage: null, costUsd: null, status: "promoted", gateNotes: [], catalystDate: null, rankScore: 15 });
    await store.insertTrack({ cardId: c.id, symbol: c.primaryTicker, sectorEtf: "XLK", direction: c.direction, cardDate: "2026-11-20", deadlineDate: "2026-12-20" });
    expect((await call(String(c.id))).status).toBe(401);
    expect((await call(String(c.id), "Bearer nope-nope-nope-nope-nope-nope-nope-nope")).status).toBe(401);
    expect((await call(String(c.id), "Basic dXNlcjpwYXNz")).status).toBe(401);
    expect((await call("99999", `Bearer ${TOKEN}`)).status).toBe(404);
    const res = await call(String(c.id), `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ id: c.id, url: `https://scout.example/cards/${c.id}`, ticker: c.primaryTicker, direction: c.direction, promoted: true, status: "promoted", sector_etf: "XLK", benchmark: "SPY", exit_by: "2026-12-20" });
    expect(j.invalidation).toBe(sampleCard().invalidation);
    expect(j.variant_perception).toBe(sampleCard().why_not_priced);
    expect(j).not.toHaveProperty("entry"); // not entered yet: left out, not invented
    expect(JSON.stringify(j)).not.toContain(TOKEN);
  });
});

describe("cardForApi", () => {
  it("adds the entry once the paper trade has one", () => {
    const now = new Date().toISOString();
    const stored = { id: 7, versionId: 1, createdAt: now, origin: "scout", kind: sampleCard().kind, title: "t", card: sampleCard(), model: "m", modelServed: null, costUsd: null, status: "late", gateNotes: [], primaryTicker: sampleCard().tickers[0].symbol, sector: "tech", direction: "long", timeLimitDays: 30, catalystDate: null, rankScore: 1 } as unknown as store.StoredCard;
    const track = { cardId: 7, symbol: "X", sectorEtf: "XLK", direction: "long", cardDate: "2026-11-20", entryDate: "2026-11-20", entryPrice: 10, entryPriceRaw: 10, spyEntry: 600, sectorEntry: 200, deadlineDate: "2026-12-20", exitDate: null, exitPrice: null, spyExit: null, sectorExit: null, exitReason: null, maxDrawdownPct: null, tappedAt: null, swingResponse: null } as unknown as store.Track;
    const j = cardForApi(stored, track, null, "https://s/") as Record<string, unknown>;
    expect(j.entry).toEqual({ date: "2026-11-20", price: 10 });
    expect(j.promoted).toBe(false);
    expect(j.url).toBe("https://s/cards/7");
  });
});
