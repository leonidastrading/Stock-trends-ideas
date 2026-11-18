import { describe, expect, it } from "vitest";
import type { DailyBar, NewsItem } from "@/lib/alpaca";
import { avgDailyMove, cardRefs, englishWords, liveContext, liveLines, newsSearch, searchTermsFor, tickersAsked } from "@/lib/scout/live-context";

const listed = new Set(["RDDT", "NVDA", "ON", "ALL", "NOW", "URGN", "CGON", "IT"]);

describe("live data for chat questions", () => {
  it("finds the stocks a typed question names, in any case, but not everyday words", () => {
    expect(tickersAsked("Why rddt keeps dropping", listed)).toEqual(["RDDT"]);
    expect(tickersAsked("what is going on with all of it now?", listed)).toEqual([]);
    expect(tickersAsked("Compare $NOW with NVDA and urgn", listed)).toEqual(["NOW", "NVDA", "URGN"]);
    expect(tickersAsked("IT spending is up", listed)).toEqual([]);
  });

  it("writes the price, moves and the week's headlines", () => {
    const bars: DailyBar[] = Array.from({ length: 70 }, (_, i) => ({ symbol: "URGN", date: `2026-${String(8 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, o: 40, h: 41, l: 39, c: 40 - i * 0.2, v: 1 }));
    const news: NewsItem[] = [{ id: 1, ts: "2026-11-16T14:05:00Z", headline: "CG Oncology Phase 3 PIVOT-006 meets primary endpoint", summary: "", symbols: ["CGON", "URGN"], source: "benzinga", url: "u" }];
    const t = liveLines("URGN", { price: 25.61, prevClose: 27.1, at: "2026-11-16T20:59:00Z" }, bars, news);
    expect(t).toMatch(/URGN price \$25\.61 \(−5\.5% vs the previous close\)/);
    expect(t).toMatch(/over 5 sessions/);
    expect(t).toMatch(/PIVOT-006 meets primary endpoint/);
  });

  it("asks the market data for quotes, bars and news", async () => {
    const data = {
      getSnapshots: async () => ({ RDDT: { price: 150, prevClose: 160, at: null, sessionDate: null } }),
      getDailyBars: async () => [] as DailyBar[],
      getNews: async () => [] as NewsItem[],
      getCalendar: async () => [],
    };
    const t = await liveContext(data as never, ["RDDT"], new Date("2026-11-16T16:00:00Z"));
    expect(t).toMatch(/^LIVE DATA fetched/);
    expect(t).toMatch(/RDDT price \$150\.00 \(−6\.3% vs the previous close\)/);
    expect(t).toMatch(/No headlines in the last 7 days/);
    expect(await liveContext(null, ["RDDT"])).toBeNull();
  });
});

describe("normal daily move (for telling noise from a real break)", () => {
  it("averages the absolute daily change over the last 20 sessions", () => {
    const bars: DailyBar[] = Array.from({ length: 30 }, (_, i) => ({ symbol: "CAR", date: `2026-10-${String(i + 1).padStart(2, "0")}`, o: 1, h: 1, l: 1, c: i % 2 ? 102 : 100, v: 1 }));
    expect(avgDailyMove(bars)).toBeCloseTo(1.98, 1); // alternating +2% / -1.96%
    expect(avgDailyMove(bars.slice(0, 4))).toBeNull();
  });
});

describe("cards named in a chat message", () => {
  it("finds card numbers, and the word card is not the ticker CARD", () => {
    expect(cardRefs("what do you think of card #208?")).toEqual([208]);
    expect(cardRefs("compare cards #177 and #197, and card 208")).toEqual([177, 197, 208]);
    expect(cardRefs("revenue grew 39.9% in Q2")).toEqual([]);
    expect(tickersAsked("why did the scout write this card on ui", new Set(["CARD", "UI"]))).toEqual(["UI"]);
    expect(tickersAsked("is $CARD cheap", new Set(["CARD"]))).toEqual(["CARD"]);
  });
});

describe("everyday words are not tickers; the chat searches the news", () => {
  const listed = new Set(["PATH", "JETS", "RDDT", "UI", "META", "TSM"]);
  it("loads the English word list and keeps lower-case words that are English out of the tickers", () => {
    const en = englishWords();
    expect(en.has("path") && en.has("jets") && en.has("card")).toBe(true);
    expect(en.has("rddt")).toBe(false);
    expect(tickersAsked("do they have a path to profitability?", listed)).toEqual([]);
    expect(tickersAsked("did you check the news on russian fighter jets?", listed)).toEqual([]);
    expect(tickersAsked("why is rddt down and what about ui", listed)).toEqual(["RDDT", "UI"]);
    expect(tickersAsked("is META or $jets cheaper", listed)).toEqual(["META", "JETS"]);
  });

  it("searches Google News for the question's key words", async () => {
    expect(searchTermsFor("did you check the news on russian fighter jets flying over japan and taiwan?")).toEqual(["russian", "fighter", "jets", "flying", "over", "japan", "taiwan"]);
    expect(searchTermsFor("now?")).toEqual([]);
    let asked = "";
    const fetchImpl = (async (url: string) => { asked = url; return new Response(`<rss><channel><item><title>Japan sends up jets after alleged Russian incursion of its airspace - BBC</title><link>https://news.google.com/a</link><pubDate>Tue, 17 Nov 2026 20:00:00 GMT</pubDate><source url="https://bbc.com">BBC</source></item></channel></rss>`); }) as unknown as typeof fetch;
    const t = await newsSearch("russian fighter jets over japan and taiwan", fetchImpl);
    expect(decodeURIComponent(asked)).toContain("russian+fighter+jets+over+japan+taiwan+when:7d".replace(/\+/g, "+"));
    expect(t).toMatch(/NEWS SEARCH \(Google News, last 7 days, for: russian fighter jets over japan taiwan\)/);
    expect(t).toMatch(/\[BBC\] Japan sends up jets after alleged Russian incursion/);
    expect(await newsSearch("now?", fetchImpl)).toBeNull();
  });
});
