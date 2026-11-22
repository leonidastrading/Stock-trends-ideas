import { describe, expect, it } from "vitest";
import type { DailyBar, NewsItem } from "@/lib/alpaca";
import { groupStats, inWindow, isCompanyItem, priceAt, prGroup, scoreHeadline, sessionDay, type PrRow } from "@/lib/scout/pr-desk";

describe("press-release desk", () => {
  it("scores headlines with the method's keywords and flags offerings", () => {
    const a = scoreHeadline("Five Prime Announces Bemarituzumab Demonstrates Statistically Significant Survival Benefit; Primary Endpoint Met");
    expect(a.stars).toBeGreaterThanOrEqual(12);
    expect(a.hot).toEqual(expect.arrayContaining(["statistically significant", "primary endpoint", "demonstrates"]));
    expect(scoreHeadline("Acme Receives FDA Fast Track Designation").stars).toBe(2);
    expect(scoreHeadline("Acme Announces Pricing of $10 Million Registered Direct Offering").sinkers).toEqual(expect.arrayContaining(["offering", "registered direct", "pricing of"]));
    expect(scoreHeadline("Acme Reports Third Quarter 2026 Financial Results").earnings).toBe(true);
    expect(scoreHeadline("Acme metals update").stars).toBe(0); // "met" only as a whole word
  });

  it("logs only in the press-release windows on weekdays, and only company items", () => {
    expect(inWindow("2026-11-23", 8 * 60)).toBe(true);
    expect(inWindow("2026-11-23", 6 * 60 + 50)).toBe(false);
    expect(inWindow("2026-11-23", 12 * 60)).toBe(false);
    expect(inWindow("2026-11-23", 16 * 60 + 30)).toBe(true);
    expect(inWindow("2026-11-22", 8 * 60)).toBe(false); // Sunday
    const n = (symbols: string[], extra: Partial<NewsItem> = {}) => ({ id: 1, ts: "", headline: "", summary: "", symbols, source: "", url: "", ...extra }) as NewsItem;
    expect(isCompanyItem(n(["ABCD"]))).toBe(true);
    expect(isCompanyItem(n(["A", "B", "C"]))).toBe(false);
    expect(isCompanyItem(n(["ABCD"], { repostedAt: "x" }))).toBe(false);
  });

  it("prices at a moment from minute bars, and picks the session for the close", () => {
    const bars = [{ t: "2026-11-23T13:00:00Z", c: 1 }, { t: "2026-11-23T13:01:00Z", c: 2 }, { t: "2026-11-23T13:05:00Z", c: 3 }].map((b) => ({ ...b, o: b.c, h: b.c, l: b.c, v: 10 }));
    expect(priceAt(bars, Date.parse("2026-11-23T13:03:00Z"))).toBe(2);
    expect(priceAt(bars, Date.parse("2026-11-23T12:00:00Z"))).toBe(1);
    const days = [{ date: "2026-11-23", c: 10 }, { date: "2026-11-24", c: 11 }, { date: "2026-11-25", c: 12 }].map((d) => ({ symbol: "X", o: d.c, h: d.c, l: d.c, v: 1, ...d })) as DailyBar[];
    expect(sessionDay("2026-11-23T13:00:00Z", days)).toMatchObject({ day: { date: "2026-11-23" }, next: { date: "2026-11-24" } }); // 8 AM ET
    expect(sessionDay("2026-11-23T21:30:00Z", days)).toMatchObject({ day: { date: "2026-11-24" }, next: { date: "2026-11-25" } }); // 4:30 PM ET
  });

  it("groups the way the method predicts, and averages the moves", () => {
    const r = (o: Partial<PrRow>) => ({ stars: 0, sinkers: [], earnings: false, sharesOutM: null, priceSeen: 10, p15: null, p60: null, dayClose: null, nextClose: null, ...o }) as PrRow;
    expect(prGroup(r({ stars: 6, sharesOutM: 8 }))).toBe("hot_small");
    expect(prGroup(r({ stars: 6, sharesOutM: 80 }))).toBe("hot");
    expect(prGroup(r({ stars: 6, sinkers: ["offering"] }))).toBe("sinker");
    expect(prGroup(r({ earnings: true }))).toBe("earnings");
    const s = groupStats([r({ stars: 6, sharesOutM: 8, p60: 12, dayClose: 11 }), r({ stars: 6, sharesOutM: 8, p60: 9, dayClose: 9 })]).find((x) => x.group === "hot_small")!;
    expect(s).toMatchObject({ n: 2, m60: 5, mClose: 0, upClose: 50 });
  });
});

import { earlierVersion } from "@/lib/scout/pr-desk";
describe("old news told again", () => {
  it("finds the earlier headline on the same story (the Nvidia subpoena, re-written a day later)", () => {
    const prior = [
      { ts: "2026-11-19T22:10:00Z", headline: "Attorney General Bonta Serves Investigative Subpoena on Nvidia", source: "benzinga" },
      { ts: "2026-11-20T15:00:00Z", headline: "Nvidia shares slip in afternoon trade", source: "benzinga" },
    ];
    expect(earlierVersion("California Attorney General Launches Investigation into NVIDIA", "2026-11-20T19:01:43Z", prior)).toMatchObject({ ts: "2026-11-19T22:10:00Z" });
    expect(earlierVersion("Nvidia Unveils New Blackwell Server Line", "2026-11-20T19:01:43Z", prior)).toBeNull();
  });
});

import { keyWords, priorVersion } from "@/lib/scout/pr-desk";
describe("finding the earlier version across outlets", () => {
  it("picks the headline's distinctive words for the search", () => {
    expect(keyWords("NVIDIA Subject to Congressional Probe Regarding China Sales")).toEqual(["Congressional", "Regarding", "Subject"]);
  });

  it("finds it in Google News when the stock's own feed does not have it (word match, no model)", async () => {
    const rss = `<rss><channel><item><title>Nvidia Subject to Congressional Probe Over Ties to Commerce Department, Possible China Sales - MarketScreener</title><link>https://ms/1</link><pubDate>Fri, 20 Nov 2026 11:31:00 GMT</pubDate><source>MarketScreener</source></item></channel></rss>`;
    const fetchImpl = (async () => new Response(rss, { status: 200 })) as unknown as typeof fetch;
    const data = { getNews: async () => [] } as never;
    const hit = await priorVersion(data, "NVDA", "NVIDIA Subject to Congressional Probe Regarding China Sales", "2026-11-20T19:01:43Z", { fetchImpl, company: "NVIDIA Corporation Common Stock", judge: false });
    expect(hit).toMatchObject({ ts: "2026-11-20T11:31:00.000Z", source: "MarketScreener" });
  });
});
