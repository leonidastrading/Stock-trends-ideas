import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { crowdVerdict, DOTS_PROMPT, dotsRuns, numberHeadlines, parseDots, runDots, type Headline } from "@/lib/scout/dots";
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

  it("reads the behaviour searches, asks once, measures how late GNRC is, and logs the run", async () => {
    let n = 0;
    const rss = () => `<rss><channel>${Array.from({ length: 4 }, () => { n++; return `<item><title>Story ${n}: generators fly off the shelves</title><link>https://news.example/${n}</link><pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate><source>Paper ${n}</source></item>`; }).join("")}</channel></rss>`;
    const fetchImpl = (async (url: string) => (String(url).includes("news.google.com") ? new Response(rss()) : new Response("", { status: 404 }))) as typeof fetch;
    const prompts: string[] = [];
    const callModel: CallModel = async ({ user, purpose }) => {
      prompts.push(`${purpose}: ${user.slice(0, 200)}`);
      return { text: JSON.stringify({ ideas: [{ title: "Grid fears drive generator buying", one_line: "Long GNRC: generator panic buying.", chain: ["fear", "generators", "Generac"], tickers: ["GNRC"], direction: "long", why_not_obvious: "local news", evidence: [1, 2], confirm_with: "search interest", breaks_it: "fades", horizon_days: 45, confidence: 50 }] }), stopReason: "end_turn", modelServed: "test", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const bars = Array.from({ length: 70 }, (_, i) => ({ symbol: "GNRC", date: new Date(Date.UTC(2026, 7, 1) + i * 86400_000).toISOString().slice(0, 10), o: 100, h: 101, l: 99, c: i === 69 ? 104 : 100, v: 1e6 }));
    const data = { getDailyBars: async () => bars, getNews: async () => [{ id: 1, ts: "2026-11-10T00:00:00Z", headline: "x", summary: "", symbols: ["GNRC"], source: "x", url: "" }], getCalendar: async () => [] } as never;
    const r = await runDots({ data, callModel, now: new Date("2026-11-19T14:00:00Z"), fetchImpl });
    expect(r).toMatch(/^1 ideas from \d+ headlines$/);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^dots: Today is 2026-11-19/);
    const [run] = await dotsRuns(1);
    expect(run.ideas[0].crowd?.GNRC).toMatchObject({ move1m: 4, news30d: 1, verdict: "early" });
    expect(run.ideas[0].prices?.GNRC).toBe(104);
    expect(run.ideas[0].evidence[0].url).toMatch(/^https:\/\/news\.example\//);
  });
});
