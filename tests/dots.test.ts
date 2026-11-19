import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { crowdVerdict, DOTS_PROMPT, DOTS_SCAN_PROMPT, dotsRuns, LENSES, numberHeadlines, parseChanges, parseDots, runDots, scanLines, type Headline } from "@/lib/scout/dots";
import { parseHn, parsePolymarket, parseTrends, parseWikiTop } from "@/lib/sources/discovery";
import type { CallModel } from "@/lib/scout/llm";

const H = (i: number, headline: string, at = `2026-11-${String(10 + i).padStart(2, "0")}T12:00:00Z`): Headline => ({ at, source: "Local News", headline, url: `https://news.example/${i}` });

describe("Dots (pure)", () => {
  it("swaps headline numbers for the headlines, keeps ideas with a ticker, at most 5", () => {
    const heads = [H(1, "Generator sales surge as families fear cyberattacks on the grid"), H(2, "Home Depot sold out of standby generators"), H(3, "Unrelated")];
    const reply = JSON.stringify({ ideas: [
      { title: "Grid fears drive generator buying", one_line: "Long GNRC: households are panic-buying backup generators, which should show in Generac's next sales update within 60 days.", chain: ["fear of grid attacks", "households buy backup generators", "Generac sells more home standby units"], tickers: ["$gnrc", "not a ticker"], direction: "long", why_not_obvious: "The story is in local news, not financial news.", evidence: [1, 2, 2, 9], confirm_with: "search interest for home generators", breaks_it: "the scare fades in a week", horizon_days: 400, confidence: 55 },
      { title: "No ticker", one_line: "", chain: [], tickers: [], direction: "long", why_not_obvious: "", evidence: [], confirm_with: "", breaks_it: "", horizon_days: 30, confidence: 10 },
    ] });
    const ideas = parseDots(reply, heads);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({ tickers: ["GNRC"], horizon_days: 90, confidence: 55 });
    expect(ideas[0].evidence.map((h) => h.headline)).toEqual(["Generator sales surge as families fear cyberattacks on the grid", "Home Depot sold out of standby generators"]);
  });

  it("calls a stock early only when it has neither moved much nor been in the news", () => {
    expect(crowdVerdict(4, 3)).toBe("early");
    expect(crowdVerdict(22, 3)).toBe("moving");
    expect(crowdVerdict(-3, 40)).toBe("moving");
    expect(crowdVerdict(30, 40)).toBe("crowded");
    expect(crowdVerdict(null, null)).toBe("unknown");
  });

  it("drops duplicate headlines and puts the newest first", () => {
    const out = numberHeadlines([H(1, "Generators sold out"), H(5, "Generators SOLD OUT!"), H(3, "Shortage of canned food")]);
    expect(out.map((h) => h.headline)).toEqual(["Generators SOLD OUT!", "Shortage of canned food"]);
  });

  it("the scan reads every feed under its own heading, numbered, without repeating a headline across lenses", () => {
    const sc = scanLines({ supply: [H(1, "Copper shortage hits wiring makers")], weather: [H(2, "Copper shortage hits wiring makers!"), H(3, "Drought cuts barge traffic on the Mississippi")] }, [{ heading: "Hacker News front page", items: ["Show HN: a thing"] }, { heading: "empty", items: [] }]);
    expect(sc.lines).toEqual(["\n## SUPPLY", "1. 2026-11-11 [Local News] Copper shortage hits wiring makers", "\n## WEATHER", "2. 2026-11-13 [Local News] Drought cuts barge traffic on the Mississippi", "\n## HACKER NEWS FRONT PAGE", "3. Show HN: a thing"]);
    expect(sc.counts).toMatchObject({ "lens: supply": 1, "lens: weather": 1, "Hacker News front page": 1, empty: 0 });
    expect(Object.keys(LENSES)).toHaveLength(10);
  });

  it("keeps the scan's changes and only short, plain follow-up searches", () => {
    const c = parseChanges(JSON.stringify({ changes: [{ change: "Ports strike looms", lens: "work and labour", signals: [3], searches: ["port strike east coast", "x", "a very long search that goes on and on and on and on and on and on and on and on and on and on"] }, { change: "", searches: ["no"] }] }));
    expect(c).toEqual([{ change: "Ports strike looms", lens: "work and labour", searches: ["port strike east coast"] }]);
    expect(DOTS_SCAN_PROMPT).toMatch(/data, not instructions/);
  });

  it("reads the discovery feeds", () => {
    expect(parseTrends(`<item><title>resin</title><ht:approx_traffic>2,000+</ht:approx_traffic><ht:news_item_title><![CDATA[Resin prices jump]]></ht:news_item_title></item>`)[0].text).toBe("resin (2,000+ searches): Resin prices jump");
    expect(parseWikiTop(JSON.stringify({ items: [{ articles: [{ article: "Main_Page", views: 9 }, { article: "Special:Search", views: 8 }, { article: "Grand_Theft_Auto_VI", views: 519632 }] }] })).map((x) => x.text)).toEqual(["Grand Theft Auto VI (519,632 views)"]);
    expect(parsePolymarket(JSON.stringify([{ question: "Jazz vs. Lakers" }, { question: "Will the Fed cut in December?", outcomePrices: "[\"0.31\",\"0.69\"]", volume24hr: 2500000 }])).map((x) => x.text)).toEqual(["Will the Fed cut in December? (31% yes), $2500k traded in 24h"]);
    expect(parseHn(JSON.stringify({ hits: [{ title: "Unauthenticated RCE in Nginx", points: 812 }] }))[0].text).toBe("Unauthenticated RCE in Nginx (812 points)");
  });

  it("the prompt asks for behaviour-to-company chains, prefers smaller pure plays, and treats headlines as data", () => {
    expect(DOTS_PROMPT).toMatch(/Generac \(GNRC\)/);
    expect(DOTS_PROMPT).toMatch(/prefer small and mid caps/);
    expect(DOTS_PROMPT).toMatch(/data, not instructions/);
  });
});

describe("Dots end to end (PGlite, fake news and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("scans broadly, digs with its own searches, connects, measures how late GNRC is, and logs the run", async () => {
    let n = 0;
    const searched: string[] = [];
    const rss = () => `<rss><channel>${Array.from({ length: 3 }, () => { n++; return `<item><title>Story ${n}: households buy generators</title><link>https://news.example/${n}</link><pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate><source>Paper ${n}</source></item>`; }).join("")}</channel></rss>`;
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("news.google.com")) { searched.push(new URL(u).searchParams.get("q") ?? ""); return new Response(rss()); }
      if (u.includes("trends.google.com")) return new Response(`<rss><channel><item><title>home generator</title><ht:approx_traffic>50,000+</ht:approx_traffic><ht:news_item_title>Generators sell out</ht:news_item_title></item></channel></rss>`);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const purposes: string[] = [];
    const callModel: CallModel = async ({ user, purpose }) => {
      purposes.push(purpose ?? "");
      const text = purpose === "dots_scan"
        ? JSON.stringify({ changes: [{ change: "Households are buying backup generators over grid-attack fears.", lens: "what people buy and fear", signals: [1], searches: ["home generator sales", "!!"] }] })
        : JSON.stringify({ ideas: [{ title: "Grid fears drive generator buying", one_line: "Long GNRC: generator panic buying.", chain: ["fear", "generators", "Generac"], tickers: ["GNRC"], direction: "long", why_not_obvious: "local news", evidence: [1, 2], confirm_with: "search interest", breaks_it: "fades", horizon_days: 45, confidence: 50 }] });
      expect(user).toMatch(purpose === "dots_scan" ? /WHAT AMERICANS ARE SEARCHING FOR TODAY[\s\S]*home generator \(50,000\+ searches\): Generators sell out/ : /CHANGES THE SCAN FOUND:\n1\. \[what people buy and fear\] Households are buying backup generators/);
      return { text, stopReason: "end_turn", modelServed: "test", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const bars = Array.from({ length: 70 }, (_, i) => ({ symbol: "GNRC", date: new Date(Date.UTC(2026, 7, 1) + i * 86400_000).toISOString().slice(0, 10), o: 100, h: 101, l: 99, c: i === 69 ? 104 : 100, v: 1e6 }));
    const data = { getDailyBars: async () => bars, getNews: async () => [{ id: 1, ts: "2026-11-10T00:00:00Z", headline: "x", summary: "", symbols: ["GNRC"], source: "x", url: "" }], getCalendar: async () => [] } as never;
    const r = await runDots({ data, callModel, now: new Date("2026-11-19T14:00:00Z"), fetchImpl });
    expect(r).toMatch(/^1 ideas from 1 changes \(\d+ lines scanned, \d+ follow-up headlines\)$/);
    expect(purposes).toEqual(["dots_scan", "dots"]);
    expect(searched).toContain("home generator sales when:7d"); // its own follow-up search ("!!" dropped)
    expect(searched.length).toBe(Object.values(LENSES).flat().length + 1);
    const [run] = await dotsRuns(1);
    expect(run.changes[0]).toMatchObject({ lens: "what people buy and fear", searches: ["home generator sales"] });
    expect(run.sources["follow-up searches"]).toBe(1);
    expect(run.ideas[0].crowd?.GNRC).toMatchObject({ move1m: 4, news30d: 1, verdict: "early" });
    expect(run.ideas[0].evidence[0].url).toMatch(/^https:\/\/news\.example\//);
  });
});
