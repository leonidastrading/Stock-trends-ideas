import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData, NewsItem } from "@/lib/alpaca";
import { setQuerierForTests } from "@/lib/db";
import { filingsToOpen, filingText, itemsOf, materialReason, primaryFilings, topOfficerLeaving } from "@/lib/scout/primary";
import { buildStoryPrompt, STORY_SYSTEM_PROMPT, type Story } from "@/lib/scout/stories";

const k8 = (sym: string, items: string, ts: string, id = Math.round(Math.random() * 1e9)): NewsItem => ({ id, ts, headline: `${sym} Inc files 8-K`, summary: `SEC filing, items ${items}.`, symbols: [sym], source: "SEC 8-K", url: `https://www.sec.gov/Archives/edgar/data/1618732/00016187322600012${id % 10}/0001618732-26-00012${id % 10}-index.htm` });
const NTNX = "Item 5.02 Departure of Directors or Certain Officers. On November 24, 2026, Rajiv Ramaswami notified the Board that he will step down as President and Chief Executive Officer of the Company, effective upon the appointment of his successor. The Board has begun a search. Item 2.02 Results of Operations.";

describe("which filings are news by themselves", () => {
  it("reads the items a live 8-K names", () => {
    expect(itemsOf({ summary: "SEC filing, items 5.02, 2.02, 9.01." })).toEqual(["5.02", "2.02", "9.01"]);
  });

  it("an officer change counts only when the chief executive or finance chief is leaving", () => {
    expect(topOfficerLeaving(NTNX)).toBe("chief executive");
    expect(topOfficerLeaving("On May 1, Jane Roe resigned as Chief Financial Officer to pursue another opportunity.")).toBe("finance chief");
    expect(topOfficerLeaving("The Company announced that its CFO will retire at the end of the fiscal year.")).toBe("finance chief");
    // Directors, hires and pay plans: most item 5.02 filings.
    expect(topOfficerLeaving("John Doe resigned from the Board of Directors. His resignation was not due to any disagreement.")).toBeNull();
    expect(topOfficerLeaving("The Board appointed Ann Lee as Chief Executive Officer, effective June 1.")).toBeNull();
    expect(topOfficerLeaving("The Compensation Committee approved the 2027 bonus plan for the Chief Executive Officer.")).toBeNull();
    // A hire that replaces someone is still the top job changing hands.
    expect(topOfficerLeaving("The Board appointed Ann Lee as Chief Executive Officer to succeed Bob Ray, who retired.")).toBe("chief executive");
  });

  it("names why a filing matters, or passes on it", () => {
    expect(materialReason(["5.02", "2.02", "9.01"], NTNX)).toBe("the chief executive is leaving");
    expect(materialReason(["4.02", "9.01"], "Item 4.02 ...")).toBe("past financial statements can no longer be relied on");
    expect(materialReason(["5.02", "2.05"], "A director resigned. Item 2.05 Costs Associated with Exit or Disposal Activities.")).toBe("restructuring or exit costs");
    // Results alone belong to the earnings desk; a director leaving is nothing.
    expect(materialReason(["2.02", "9.01"], "Item 2.02 Results of Operations.")).toBeNull();
    expect(materialReason(["5.02"], "John Doe resigned from the Board of Directors.")).toBeNull();
  });

  it("opens only recent 8-Ks that could matter, newest first", () => {
    const now = new Date("2026-11-25T13:00:00Z");
    const items = [k8("NTNX", "5.02, 2.02", "2026-11-25T12:31:00Z", 1), k8("EARN", "2.02, 9.01", "2026-11-25T12:40:00Z", 2), k8("OLD", "4.02", "2026-11-25T08:00:00Z", 3), k8("CYBR", "1.05", "2026-11-25T12:50:00Z", 4), { ...k8("NEWS", "5.02", "2026-11-25T12:55:00Z", 5), source: "reuters" }];
    expect(filingsToOpen(items, now).map((n) => n.symbols[0])).toEqual(["CYBR", "NTNX"]);
  });

  it("the desk is shown the filing's text and told it is early, not unimportant", () => {
    const story = { key: "NTNX", symbols: ["NTNX"], stories: 1, mainstream: 0, shockHits: 0, escalationHits: 0, escalation: [], headlines: [], primary: { what: "8-K filed 7:31 AM ET: the chief executive is leaving", url: "https://www.sec.gov/x", text: NTNX } } as unknown as Story;
    expect(buildStoryPrompt([story], "2026-11-25")).toContain('Primary source, read by the scout (8-K filed 7:31 AM ET: the chief executive is leaving): "Item 5.02 Departure of Directors');
    expect(STORY_SYSTEM_PROMPT).toContain("thin coverage is not a reason to skip it and a low headline count means you are early");
  });
});

describe("opening the filings (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  const body = (text: string) => `<html><body><p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION FORM 8-K cover page boilerplate that goes on for a while and says nothing at all about the news in the filing itself.</p><p>${text}</p></body></html>`;
  const sec = (texts: Record<string, string>): typeof fetch => (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/index.json")) return Response.json({ directory: { item: [{ name: "0001-index.htm" }, { name: "form8k.htm" }, { name: "ex99-1.htm" }, { name: "R1.xml" }] } });
    const acc = /\/(\d{18})\//.exec(u)?.[1] ?? "";
    if (u.endsWith("/form8k.htm")) return new Response(body(texts[acc] ?? "Item 8.01 Other Events. Nothing much."));
    if (u.endsWith("/ex99-1.htm")) return new Response("<html><body><p>NEWS RELEASE. The Company today announced the matters described in this report, with further detail for investors and the dates that apply to each of them, including the timing of the search and the interim arrangements the Board has put in place.</p></body></html>");
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;

  it("reads the 8-K body from its first item, then the press-release exhibit", async () => {
    const t = await filingText("https://www.sec.gov/Archives/edgar/data/1618732/000161873226000121/0001618732-26-000121-index.htm", "ua", sec({ "000161873226000121": NTNX }));
    expect(t).toMatch(/^Item 5\.02 Departure of Directors or Certain Officers\. On November 24, 2026, Rajiv Ramaswami/);
    expect(t).toContain("NEWS RELEASE. The Company today announced");
    expect(t).not.toContain("cover page boilerplate that goes on");
    expect(await filingText("https://example.com/not-sec/x-index.htm", "ua", sec({}))).toBeNull();
  });

  it("hands over the filing that matters, once, and leaves cheap stocks and routine filings alone", async () => {
    const now = new Date("2026-11-25T13:00:00Z");
    const items = [k8("NTNX", "5.02, 2.02", "2026-11-25T12:31:00Z", 1), k8("DIRX", "5.02", "2026-11-25T12:40:00Z", 2), k8("PENY", "4.02", "2026-11-25T12:45:00Z", 3)];
    const data = { getSnapshots: async () => ({ NTNX: { price: 54.6 }, DIRX: { price: 30 }, PENY: { price: 1.2 } }) } as unknown as MarketData;
    const deps = { data, env: { SEC_USER_AGENT: "ua" } as unknown as NodeJS.ProcessEnv, now, fetchImpl: sec({ "000161873226000121": NTNX, "000161873226000122": "Item 5.02. John Doe resigned from the Board of Directors." }) };
    const got = await primaryFilings(items, deps);
    expect([...got.keys()]).toEqual(["NTNX"]);
    expect(got.get("NTNX")).toMatchObject({ what: "8-K filed 7:31 AM ET: the chief executive is leaving" });
    expect(got.get("NTNX")!.text).toContain("he will step down as President and Chief Executive Officer");
    // The same filings again: nothing is opened twice.
    expect((await primaryFilings(items, deps)).size).toBe(0);
    // Without the SEC's required contact header the scout does not ask.
    expect((await primaryFilings([k8("NEWX", "4.02", "2026-11-25T12:59:00Z", 7)], { ...deps, env: {} as NodeJS.ProcessEnv })).size).toBe(0);
  });
});
