import { describe, expect, it } from "vitest";
import type { FeedItem } from "@/lib/scout/newsfeed";
import { applyPicks, candidates, promptList, ruleTop, weight } from "@/lib/scout/top-news";

const now = new Date("2026-11-23T15:00:00Z");
const item = (id: string, hoursAgo: number, score: number, symbols: string[], headline = `Headline ${id}`, extra: Partial<FeedItem> = {}): FeedItem => ({
  id, at: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), headline, summary: "", source: "Benzinga", url: `https://x/${id}`, symbols,
  event: "merger", cardIds: [], buzz: 1, score: Math.round(score * Math.pow(0.5, hoursAgo / 6) * 100) / 100, kind: "news", ...extra,
});

describe("top news", () => {
  it("weighs stories by size, not freshness", () => {
    const big = item("big", 18, 4, ["NVDA"]), small = item("small", 0.5, 1.5, ["XYZ"]);
    expect(weight(big, now)).toBeCloseTo(4, 1);
    expect(candidates([small, big], now).map((c) => c.id)).toEqual(["big", "small"]);
  });

  it("leaves out old items, re-posts, routine pauses and repeated headlines", () => {
    const c = candidates([item("old", 30, 5, ["A"]), item("re", 1, 5, ["B"], "x", { repostedAt: "2026-11-23T14:00:00Z" }), item("p", 1, 5, ["C"], "y", { event: "paused" }), item("d1", 1, 3, ["D"], "Same story"), item("d2", 2, 3, ["D"], "Same story!")], now);
    expect(c.map((x) => x.id)).toEqual(["d2"]); // the earlier of the two
  });

  it("rules: one story per stock", () => {
    const r = ruleTop([item("a", 1, 4, ["AAPL"]), item("b", 2, 3.5, ["AAPL"]), item("c", 3, 3, ["MSFT"])], now);
    expect(r.map((p) => p.id)).toEqual(["a", "c"]);
    expect(r[0].why).toBe("merger");
  });

  it("maps the model's picks, dropping unknown and repeated ids", () => {
    const cands = [item("a", 1, 4, ["AAPL"]), item("b", 2, 3, ["MSFT"])];
    expect(applyPicks(cands, [{ id: "b", why: " Big deal " }, { id: "zz", why: "x" }, { id: "b", why: "again" }, { id: "a", why: "y" }]).map((p) => [p.id, p.why])).toEqual([["b", "Big deal"], ["a", "y"]]);
  });

  it("lists candidates for the model with id, ET time, source and tickers", () => {
    expect(promptList([item("a", 1, 4, ["AAPL"], "Apple buys X")])).toBe("[a] 2026-11-23 09:00 ET · Benzinga · AAPL\nApple buys X");
  });
});

import { aiCandidates, CLASS_ACTION_AD, parseGoogleNews } from "@/lib/scout/top-news";
const RSS = `<rss><channel><title>Business</title>
<item><title>South Korea readies $8 billion stock stabilization fund as KOSPI slides - Reuters</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Mon, 23 Nov 2026 01:10:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title><![CDATA[ECB warns AI debt could spread losses to bonds - Euronews]]></title><link>https://news.google.com/rss/articles/def?oc=5</link><pubDate>Sun, 22 Nov 2026 20:00:00 GMT</pubDate><source url="https://www.euronews.com">Euronews</source></item>
<item><title>Old story - AP</title><link>https://news.google.com/rss/articles/old</link><pubDate>Thu, 19 Nov 2026 10:00:00 GMT</pubDate><source url="https://apnews.com">AP</source></item>
</channel></rss>`;

describe("general news for the top ten", () => {
  it("parses Google News: headline without the outlet, the outlet as source, last 24 hours only", () => {
    const g = parseGoogleNews(RSS, now);
    expect(g.map((x) => [x.headline, x.source])).toEqual([["South Korea readies $8 billion stock stabilization fund as KOSPI slides", "Reuters"], ["ECB warns AI debt could spread losses to bonds", "Euronews"]]);
    expect(g[0].url).toBe("https://news.google.com/rss/articles/abc?oc=5");
  });

  it("gives the model general headlines next to the feed's strongest, and drops class-action ads", () => {
    const feed = [item("a", 1, 4, ["AAPL"]), item("ad", 1, 5, ["DAVA"], "DAVA Investors Have Opportunity to Lead Endava plc Securities Fraud Lawsuit with SBS Law")];
    const c = aiCandidates(feed, parseGoogleNews(RSS, now), now);
    expect(c.map((x) => x.id)).toContain("a");
    expect(c.some((x) => x.headline.startsWith("South Korea"))).toBe(true);
    expect(c.some((x) => x.id === "ad")).toBe(false);
    expect(CLASS_ACTION_AD.test("Rosen Law Firm Reminds Investors of Deadline")).toBe(true);
    expect(CLASS_ACTION_AD.test("CrowdStrike to buy Zscaler")).toBe(false);
  });
});

describe("class-action ads", () => {
  it("catches the ads, keeps real lawsuit news", () => {
    expect(CLASS_ACTION_AD.test("Pomerantz Law Firm Announces the Filing of a Class Action Against XYZ")).toBe(true);
    expect(CLASS_ACTION_AD.test("Judge certifies class action against Meta over teen safety")).toBe(false);
  });
});

describe("more law-firm ads", () => {
  it("catches 'contact the law group to discuss your rights'", () => {
    expect(CLASS_ACTION_AD.test("Coastal Financial Corporation Sued for Securities Law Violations - Contact the DJS Law Group to Discuss Your Rights - CCB")).toBe(true);
  });
});

import { oneStoryEach, sameStory } from "@/lib/scout/top-news";
describe("one pick per story", () => {
  const H = [
    "Jensen Huang reinstated as Nvidia CEO, board says",
    "NVIDIA Reinstates Jensen Huang as President and CEO",
    "Trump: Trump praises NVIDIA's board for returning Jensen Huang as CEO, says the government sees no national security risk",
    "Nasdaq roars back by 6% as Nvidia soars on Huang’s return, S&P 500 rebounds 4%: Live updates",
    "Fed's Waller says a 50 basis point hike is on the table for December",
    "Nvidia faces California subpoena over China chip sales",
  ];
  it("folds the filing, the reaction and the market move into the first report", () => {
    expect(sameStory(H[0], H[1])).toBe(true);
    expect(sameStory(H[0], H[5])).toBe(false); // same company, another story
    expect(oneStoryEach(H.map((headline) => ({ headline }))).map((x) => x.headline)).toEqual([H[0], H[4], H[5]]);
  });
  it("drops picks the model labels as the same event", () => {
    const cands = [item("a", 1, 4, ["AAPL"], "Apple buys a chip designer"), item("b", 2, 3, ["QQQ"], "Tech rally lifts Nasdaq to a record"), item("c", 3, 3, ["MSFT"], "Microsoft cuts cloud prices")];
    const got = applyPicks(cands, [{ id: "a", event: "Apple chip deal", why: "x" }, { id: "b", event: "apple chip deal", why: "y" }, { id: "c", event: "microsoft price cut", why: "z" }]);
    expect(got.map((p) => p.id)).toEqual(["a", "c"]);
  });
});

describe("one company's news is one story", () => {
  it("folds the report, the price move, the filing and the market reaction into the first", async () => {
    const { companiesIn, leadName, oneStoryEach } = await import("@/lib/scout/top-news");
    const names = { NVDA: "NVIDIA Corporation Common Stock", AMAT: "Applied Materials, Inc.", E: "Eni S.p.A." };
    const picks = [
      { headline: "Nvidia reinstates Jensen Huang as CEO amid pressure from Trump, investors", symbols: [] as string[] },
      { headline: "Nasdaq roars back by 6% as Nvidia soars on Huang’s return, S&P 500 rebounds 4%: Live updates", symbols: [] },
      { headline: "NVDA up 31.7% today, no headline in the scout's feeds yet", symbols: ["NVDA"] },
      { headline: "NVIDIA CORP files 8-K: officer or director change", symbols: ["NVDA"] },
      { headline: "CrowdStrike to Buy Zscaler in $44 Billion Stock Swap", symbols: [] },
      { headline: "AMAT up 13.7% today: David Tepper's Appaloosa Management Discloses New Position in Applied Materials", symbols: ["AMAT"] },
      { headline: "Vår Energi, an Eni subsidiary, to acquire Norwegian assets from ConocoPhillips", symbols: ["E"] },
      { headline: "Oil Futures Start Week Lower as Middle East Flows Continue", symbols: ["USO", "XLE"] },
      { headline: "Energy shares slip with crude", symbols: ["XLE"] },
    ];
    expect(oneStoryEach(picks, names).map((p) => p.headline.slice(0, 12))).toEqual(["Nvidia reins", "CrowdStrike ", "AMAT up 13.7", "Vår Energi, ", "Oil Futures ", "Energy share"]);
    // Without the names, the two items that carry the ticker still fold together; index funds never join stories.
    expect(oneStoryEach(picks).map((p) => p.headline.slice(0, 12))).toContain("NVDA up 31.7");
    expect(oneStoryEach(picks).map((p) => p.headline.slice(0, 12))).not.toContain("NVIDIA CORP ");
    expect(leadName("NVIDIA Corporation Common Stock")).toBe("nvidia");
    expect(leadName("Applied Materials, Inc.")).toBe("applied materials");
    expect(leadName("Eni S.p.A.")).toBe("");
    expect(leadName("Target Corporation")).toBe("");
    expect([...companiesIn({ headline: "Citigroup Adjusts Price Target on Salesforce", symbols: ["CRM"] }, { TGT: "Target Corporation", CRM: "Salesforce, Inc." })]).toEqual(["CRM"]);
  });
});
