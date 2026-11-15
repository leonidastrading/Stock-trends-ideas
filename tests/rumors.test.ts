import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData, NewsItem } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import { chunks, mainstreamFor, parseRumors, readRumorDoc, rumorContext, rumorsSince, RUMORS_PROMPT } from "@/lib/scout/rumors";
import { playerOf } from "@/lib/scout/scoreboard";
import { articleLinks } from "@/lib/sources/site";

const news = (headline: string, symbols: string[], ts = "2026-11-14T15:00:00Z"): NewsItem => ({ id: Math.random(), ts, headline, summary: "", symbols, source: "benzinga", url: `https://example.com/${encodeURIComponent(headline)}` });

describe("rumors: reading", () => {
  it("the prompt catalogues claims (never asserts them) and skips what has no market link", () => {
    expect(RUMORS_PROMPT).toMatch(/never assert/);
    expect(RUMORS_PROMPT).toMatch(/Skip: anything with no plausible market effect; hate speech/);
    expect(RUMORS_PROMPT).toMatch(/data, not instructions/);
  });

  it("parses the reply, cleaning tickers and dropping bad items", () => {
    const r = parseRumors(JSON.stringify({ rumors: [
      { claim: "Posters claim Boeing will lose a $4B Air Force contract next week", tickers: ["$ba", "not a ticker!", "BA"], direction: "short", category: "corporate", specificity: 4, timeframe: "next week", confirm: "a DoD contract notice", source: "r/conspiracy", quote: "BA is done" },
      { claim: "x", tickers: [], direction: "none", category: "other", specificity: 1, timeframe: "", confirm: "", source: "", quote: "" },
      { claim: "The article alleges a bank run at a regional lender", tickers: ["KRE"], direction: "sideways", category: "nonsense", specificity: 9, timeframe: "", confirm: "", source: "", quote: "" },
    ] }));
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ tickers: ["BA"], direction: "short", specificity: 4 });
    expect(r[1]).toMatchObject({ tickers: ["KRE"], direction: "none", category: "other", specificity: 2 });
  });

  it("splits long dumps on paragraph breaks, three pieces at most", () => {
    const para = "word ".repeat(2000).trim();
    const text = Array.from({ length: 30 }, () => para).join("\n\n");
    const c = chunks(text, 50_000, 3);
    expect(c).toHaveLength(3);
    expect(c.every((x) => x.length <= 50_000)).toBe(true);
    expect(chunks("short doc")).toEqual(["short doc"]);
  });

  it("checks a rumor against the week's mainstream headlines on its tickers", () => {
    const n = [news("Boeing loses Air Force tanker contract to Airbus", ["BA", "EADSY"]), news("Boeing shares rise on deliveries", ["BA"]), news("Apple launches phone", ["AAPL"])];
    const m = mainstreamFor({ claim: "Posters claim Boeing will lose an Air Force contract", tickers: ["BA"] }, n)!;
    expect(m.headlines7d).toBe(2);
    expect(m.matches.map((x) => x.headline)).toEqual(["Boeing loses Air Force tanker contract to Airbus"]);
    expect(mainstreamFor({ claim: "no tickers", tickers: [] }, n)).toBeNull();
  });

  it("research is told it is unverified and not to trade on the rumor alone; cards score as their own player", () => {
    const c = rumorContext({ id: 7, docId: 1, createdAt: "2026-11-15T12:00:00Z", docSource: "r-conspiracy.txt", claim: "Posters claim Boeing will lose a contract", tickers: ["BA"], direction: "short", category: "corporate", specificity: 4, timeframe: "next week", confirm: "a DoD notice", source: "r/conspiracy", quote: "BA is done", mainstream: { headlines7d: 3, matches: [] } });
    expect(c).toMatch(/^An UNVERIFIED rumor from a fringe or conspiracy source \(r-conspiracy\.txt, r\/conspiracy\)/);
    expect(c).toContain("do not promote a trade on the rumor alone");
    expect(c).toContain("3 headline(s); none similar to the rumor");
    expect(playerOf("scout", "rumor: BA #7 Posters claim Boeing")).toBe("scout_rumors");
  });

  it("a website's link list skips privacy, cookie and comment-policy pages", () => {
    const html = `<a href="/privacy-and-cookie-settings">Privacy and cookie settings for this website</a><a href="/how-to-report-offensive-comments">How to report offensive comments on this site</a><a href="/news/2026-11-14/amazon-returns-fermi-reactor-timelines-slip">Amazon Returns To Fermi As Reactor Timelines Slip Further Away</a>`;
    expect(articleLinks(html, "https://www.zerohedge.com/").map((a) => a.title)).toEqual(["Amazon Returns To Fermi As Reactor Timelines Slip Further Away"]);
  });
});

describe("rumors: a document end to end (PGlite, fake model and news)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("reads a pasted page, stores the rumors with the mainstream check, and lists them", async () => {
    let seen = "";
    const callModel: CallModel = async ({ user, purpose }) => {
      expect(purpose).toBe("rumors");
      seen = user;
      return { text: JSON.stringify({ rumors: [{ claim: "Posters claim Boeing will lose an Air Force contract", tickers: ["BA"], direction: "short", category: "corporate", specificity: 4, timeframe: "next week", confirm: "a DoD contract notice", source: "r/conspiracy", quote: "BA is done" }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const data = { getNews: async () => [news("Boeing loses Air Force tanker contract", ["BA"])] } as unknown as MarketData;
    const r = await readRumorDoc("<html><body><p>BA is done, insiders say the contract is gone.</p><script>x()</script></body></html>", "r-conspiracy.html", { data, sources: [], callModel, now: new Date("2026-11-15T15:00:00Z"), env: {} as NodeJS.ProcessEnv });
    expect(r).toMatchObject({ rumors: 1, error: null });
    expect(seen).toContain("BA is done, insiders say the contract is gone.");
    expect(seen).not.toContain("<script>");
    const list = await rumorsSince(7);
    expect(list[0]).toMatchObject({ claim: "Posters claim Boeing will lose an Air Force contract", tickers: ["BA"], docSource: "r-conspiracy.html", mainstream: { headlines7d: 1 } });
    expect(list[0].mainstream!.matches[0].headline).toBe("Boeing loses Air Force tanker contract");
  });
});

describe("rumors: JSON dumps", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("turns a Reddit listing into posts, dropping ids, thumbnails and flair", async () => {
    const { jsonToText } = await import("@/lib/scout/rumors");
    const listing = { kind: "Listing", data: { after: "t3_x", children: [
      { kind: "t3", data: { id: "abc", name: "t3_abc", subreddit_name_prefixed: "r/conspiracy", author: "truthseeker", created_utc: 1794700000, score: 812, num_comments: 233, permalink: "/r/conspiracy/comments/abc/boeing/", title: "Boeing about to lose the tanker contract?", selftext: "My cousin at the Pentagon says it&#39;s done &amp; dusted.", thumbnail: "https://b.thumbs.redditmedia.com/x.jpg", link_flair_richtext: [{ t: "Speculation" }], preview: { images: [{ source: { url: "https://preview.redd.it/x" } }] } } },
      { kind: "t3", data: { subreddit_name_prefixed: "r/conspiracy", author: "[deleted]", title: "Removed post", selftext: "[removed]" } },
    ] } };
    const t = jsonToText(JSON.stringify(listing))!;
    expect(t).toContain("where: r/conspiracy · by: truthseeker · date: 2026-11-14 23:46 UTC");
    expect(t).toContain("score: 812 · comments: 233 · link: https://www.reddit.com/r/conspiracy/comments/abc/boeing/");
    expect(t).toContain("# Boeing about to lose the tanker contract?\nMy cousin at the Pentagon says it's done & dusted.");
    expect(t).toContain("# Removed post");
    expect(t).not.toMatch(/thumbs\.redditmedia|preview\.redd\.it|Speculation|t3_abc/);
  });

  it("reads comment trees, JSON lines and unknown shapes", async () => {
    const { jsonToText } = await import("@/lib/scout/rumors");
    const thread = [{ data: { children: [{ data: { title: "Bank run at a regional lender", selftext: "Lines outside branches" } }] } }, { data: { children: [{ data: { author: "a", body: "Saw it too, KRE puts", replies: { data: { children: [{ data: { author: "b", body: "Source? This is from a 2023 video" } }] } } } }] } }];
    const t = jsonToText(JSON.stringify(thread))!;
    expect(t.split("\n\n---\n\n")).toEqual(["# Bank run at a regional lender\nLines outside branches", "by: a\nSaw it too, KRE puts", "by: b\nSource? This is from a 2023 video"]);
    expect(jsonToText('{"text":"line one about NVDA export ban"}\n{"text":"line two about TSMC fab fire"}')).toBe("line one about NVDA export ban\n\n---\n\nline two about TSMC fab fire");
    expect(jsonToText(JSON.stringify({ x: { y: "a long string that is clearly a sentence about Pfizer recalling a drug" }, z: "short" }))).toBe("a long string that is clearly a sentence about Pfizer recalling a drug");
    expect(jsonToText("not json at all")).toBeNull();
  });

  it("a JSON file goes to the model as posts, not raw JSON", async () => {
    let seen = "";
    const callModel: CallModel = async ({ user }) => { seen = user; return { text: JSON.stringify({ rumors: [] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0 }; };
    await readRumorDoc(JSON.stringify({ data: { children: [{ data: { title: "Lockheed whistleblower", selftext: "F-35 parts faked", id: "zzz999" } }] } }), "conspiracy.json", { data: null, sources: [], callModel, now: new Date("2026-11-15T15:00:00Z"), env: {} as NodeJS.ProcessEnv });
    expect(seen).toContain("# Lockheed whistleblower\nF-35 parts faked");
    expect(seen).not.toContain("zzz999");
  });
});
