import { describe, expect, it } from "vitest";
import type { NewsItem } from "@/lib/alpaca";
import { cardNews, pickNews } from "@/lib/scout/card-news";

const n = (ts: string, headline: string): NewsItem => ({ id: 1, ts, headline, summary: "", symbols: ["EWY"], source: "benzinga", url: `https://x/${headline}` });

describe("a card's latest news", () => {
  it("newest first, one per headline, only since the given time", () => {
    const items = [n("2026-11-20T10:00:00Z", "Korea exports fall"), n("2026-11-22T10:00:00Z", "BOK holds rates"), n("2026-11-21T10:00:00Z", "korea exports fall"), n("2026-11-10T10:00:00Z", "Old news")];
    expect(pickNews(items, "2026-11-15T00:00:00Z").map((x) => x.headline)).toEqual(["BOK holds rates", "korea exports fall"]);
    expect(pickNews(items, null, 2)).toHaveLength(2);
  });

  it("asks the feed once a minute per set of stocks, from a few days before the card", async () => {
    let calls = 0; let from = "";
    const data = { getNews: async (_s: string[], start: Date) => { calls++; from = start.toISOString(); return [n("2026-11-22T10:00:00Z", "BOK holds rates")]; } } as never;
    const now = new Date("2026-11-22T12:00:00Z");
    expect((await cardNews(["EWY"], "2026-11-18T14:00:00Z", now, data))[0].headline).toBe("BOK holds rates");
    await cardNews(["EWY"], "2026-11-18T14:00:00Z", new Date(now.getTime() + 30_000), data);
    expect(calls).toBe(1);
    expect(from).toBe("2026-11-15T14:00:00.000Z");
  });
});
