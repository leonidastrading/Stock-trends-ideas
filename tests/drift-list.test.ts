import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import type { DriftSetup } from "@/lib/scout/drift";
import { inSession, listBook, listResult, openEntry, recordListings, settleList, timeExit, type ListEntry } from "@/lib/scout/drift-list";

const setup = (symbol: string, over: Partial<DriftSetup> = {}): DriftSetup => ({ symbol, eventDate: "2026-11-23", eventKind: "dividend cut", eventHeadline: `${symbol} suspends its dividend`, eventUrl: "https://example.com/x", price: 7.77, asOf: "2026-11-25", ...over } as DriftSetup);

describe("the list's paper short: when and at what price", () => {
  it("knows the regular session", () => {
    expect(inSession(new Date("2026-11-25T15:40:00Z"))).toBe(true); // Wed 10:40 AM ET
    expect(inSession(new Date("2026-11-25T14:29:00Z"))).toBe(false); // 9:29
    expect(inSession(new Date("2026-11-25T21:00:00Z"))).toBe(false); // 4 PM
    expect(inSession(new Date("2026-11-28T16:00:00Z"))).toBe(false); // Saturday
  });

  it("listed while the market is closed, it enters at the next session's open", () => {
    const bars = [{ date: "2026-11-25", o: 8, c: 7.9 }, { date: "2026-11-27", o: 7.5, c: 7.4 }];
    // Wednesday evening, Thursday a holiday: Friday's open.
    expect(openEntry("2026-11-25T23:00:00Z", bars)).toEqual({ date: "2026-11-27", price: 7.5 });
    // Before Wednesday's open: Wednesday's open.
    expect(openEntry("2026-11-25T12:00:00Z", bars)).toEqual({ date: "2026-11-25", price: 8 });
    expect(openEntry("2026-11-27T23:00:00Z", bars)).toBeNull();
  });

  it("closes at the first finished session on or after the exit day", () => {
    const bars = [{ date: "2026-12-22", o: 6, c: 6.1 }, { date: "2026-12-23", o: 6, c: 5.9 }, { date: "2026-12-24", o: 6, c: 5.8 }];
    expect(timeExit("2026-12-23", bars, "2026-12-24")).toEqual({ date: "2026-12-23", price: 5.9 });
    // The exit day's session is still open.
    expect(timeExit("2026-12-23", bars, "2026-12-23")).toBeNull();
  });

  it("a short gains when the stock falls, and is compared with SPY over the same days", () => {
    const e = { entryDate: "2026-11-25", entryPrice: 10, spyEntry: 100, exitDate: null, exitPrice: null, spyExit: null } as ListEntry;
    const r = listResult(e, 9, 101, new Date("2026-11-27T15:00:00Z"))!;
    expect([Math.round(r.ret * 1000) / 1000, Math.round(r.vsSpy! * 1000) / 1000, r.days]).toEqual([0.1, 0.11, 2]);
    expect(listResult({ ...e, entryPrice: null, entryDate: null }, 9, 101)).toBeNull();
  });
});

describe("the list book (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  const bar = (symbol: string, date: string, o: number, c: number): DailyBar => ({ symbol, date, o, h: o, l: c, c, v: 1 });
  const data = {
    getMinuteBars: async (symbol: string) => (symbol === "SPY" ? [{ t: "2026-11-24T14:54:00Z", o: 680, h: 680, l: 680, c: 680, v: 1 }] : [{ t: "2026-11-24T14:50:00Z", o: 181, h: 181, l: 181, c: 181, v: 1 }, { t: "2026-11-24T14:55:00Z", o: 180, h: 180, l: 180, c: 180.5, v: 1 }, { t: "2026-11-24T14:56:00Z", o: 179, h: 179, l: 179, c: 179, v: 1 }]),
    getDailyBars: async (symbols: readonly string[]) => [
      bar("LATE", "2026-11-25", 20, 19.5), bar("LATE", "2026-11-27", 19, 18.5), bar("SPY", "2026-11-27", 690, 691),
      bar("MNRO", "2026-12-23", 6.2, 6), bar("PLXS", "2026-12-22", 170, 171), bar("SPY", "2026-12-22", 700, 701), bar("SPY", "2026-12-23", 702, 703),
    ].filter((b) => symbols.includes(b.symbol)),
  } as unknown as MarketData;

  it("enters a new setup at the price of the scan that listed it, and never twice", async () => {
    const now = new Date("2026-11-25T15:40:00Z");
    expect(await recordListings([setup("MNRO")], {}, { data, now, today: "2026-11-25", spyPrice: 685 })).toBe(1);
    // An hour later the price has moved: the entry stays where it was.
    expect(await recordListings([setup("MNRO", { price: 7.2 })], { "MNRO|2026-11-23": now.toISOString() }, { data, now: new Date("2026-11-25T16:40:00Z"), today: "2026-11-25", spyPrice: 686 })).toBe(0);
    const [e] = await listBook();
    expect([e.symbol, e.listedAt, e.entryDate, e.entryPrice, e.spyEntry, e.basis, e.exitBy]).toEqual(["MNRO", "2026-11-25T15:40:00.000Z", "2026-11-25", 7.77, 685, "listing", "2026-12-23"]);
  });

  it("a setup already on the page before the book started enters at the minute it was listed", async () => {
    await recordListings([setup("PLXS", { eventDate: "2026-11-20", price: 178 })], { "PLXS|2026-11-20": "2026-11-24T14:55:30Z" }, { data, now: new Date("2026-11-25T15:40:00Z"), today: "2026-11-25", spyPrice: 685 });
    const e = (await listBook()).find((x) => x.symbol === "PLXS")!;
    expect([e.listedAt, e.entryDate, e.entryPrice, e.spyEntry, e.basis]).toEqual(["2026-11-24T14:55:30.000Z", "2026-11-24", 180.5, 680, "minute bar"]);
  });

  it("listed after the close, it waits for the next open; and the hold ends in a close", async () => {
    await recordListings([setup("LATE", { eventDate: "2026-11-24", price: 20 })], {}, { data, now: new Date("2026-11-25T22:00:00Z"), today: "2026-11-25", spyPrice: 685 });
    expect((await listBook()).find((x) => x.symbol === "LATE")).toMatchObject({ entryDate: null, entryPrice: null, basis: "open" });
    expect(await settleList(data, new Date("2026-11-27T15:00:00Z"))).toEqual({ entered: 1, closed: 0 });
    expect((await listBook()).find((x) => x.symbol === "LATE")).toMatchObject({ entryDate: "2026-11-27", entryPrice: 19, spyEntry: 690, exitBy: "2026-12-25" });
    // Four weeks on: MNRO (exit by Dec 23) and PLXS (Dec 22) close at those sessions' closes; LATE is not due.
    expect(await settleList(data, new Date("2026-12-24T15:00:00Z"))).toEqual({ entered: 0, closed: 2 });
    const book = await listBook(400);
    expect(book.filter((x) => x.exitDate).map((x) => [x.symbol, x.exitDate, x.exitPrice, x.spyExit]).sort()).toEqual([["MNRO", "2026-12-23", 6, 703], ["PLXS", "2026-12-22", 171, 701]]);
    const r = listResult(book.find((x) => x.symbol === "MNRO")!, null, null)!;
    expect([r.closed, Math.round(r.ret * 1000) / 10]).toEqual([true, 22.8]);
  });
});
