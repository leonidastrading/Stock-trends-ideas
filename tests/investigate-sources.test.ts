import { describe, expect, it } from "vitest";
import { alreadyDone, autoBrief, autoTrigger, pickStory } from "@/lib/scout/auto-investigate";
import { linksIn, parseLeads, parsePlan, webText, type WebTrail } from "@/lib/scout/investigate";
import type { FeedItem } from "@/lib/scout/newsfeed";
import { braveHits, pageText } from "@/lib/sources/websearch";
import { cnRows, courtDockets, docketRows, frRows, ftsRows, hkRows, hkStock, secFullText } from "@/lib/sources/world-records";

describe("more records for investigations", () => {
  it("export notices from the Federal Register", () => {
    expect(frRows({ results: [{ title: "Additions to the Entity List", publication_date: "2026-11-19", html_url: "https://www.federalregister.gov/d/2026-1", abstract: "BIS adds 12 entities  under\n the EAR.", type: "Rule" }] })).toEqual([
      { date: "2026-11-19", title: "Additions to the Entity List", detail: "Rule: BIS adds 12 entities under the EAR.", url: "https://www.federalregister.gov/d/2026-1" },
    ]);
  });

  it("court dockets from CourtListener, and no call without the token", async () => {
    const rows = docketRows({ results: [{ caseName: "Doe v. Acme Corp.", court: "District Court, N.D. California", docketNumber: "3:26-cv-01234", dateFiled: "2026-10-02", suitNature: "Securities", docket_absolute_url: "/docket/123/doe-v-acme/" }] });
    expect(rows[0]).toEqual({ date: "2026-10-02", title: "Doe v. Acme Corp.", detail: "District Court, N.D. California · No. 3:26-cv-01234 · nature: Securities · open", url: "https://www.courtlistener.com/docket/123/doe-v-acme/" });
    let called = false;
    const r = await courtDockets("Acme Corp", {} as NodeJS.ProcessEnv, (async () => { called = true; return new Response("{}"); }) as typeof fetch);
    expect(called).toBe(false);
    expect(r.error).toContain("COURTLISTENER_TOKEN");
  });

  it("Hong Kong: the main listing, not a note, and the filings with their PDF links", () => {
    const pre = 'callback({"more":"1","stockInfo":[{"stockId":174833,"code":"05093","name":"TENCENT N2801"},{"stockId":7609,"code":"00700","name":"TENCENT"}]});';
    expect(hkStock(pre)).toEqual({ stockId: 7609, code: "00700", name: "TENCENT" });
    const body = JSON.stringify({ result: JSON.stringify([{ TITLE: "ANNOUNCEMENT OF THE RESULTS", DATE_TIME: "18/11/2026 16:30", STOCK_CODE: "00700<br/>80700", STOCK_NAME: "TENCENT<br/>TENCENT-R", LONG_TEXT: "Announcements and Notices - [Quarterly Results]", FILE_LINK: "/listedco/listconews/sehk/2026/1118/2026111800448.pdf" }]) });
    expect(hkRows(body)[0]).toEqual({ date: "2026-11-18", title: "ANNOUNCEMENT OF THE RESULTS", detail: "00700 80700 TENCENT TENCENT-R · Announcements and Notices - [Quarterly Results]", url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1118/2026111800448.pdf" });
  });

  it("mainland China filings from cninfo", () => {
    expect(cnRows({ announcements: [{ announcementTitle: "2026年10月<em>产销</em>快报", announcementTime: Date.parse("2026-11-02T08:00:00Z"), adjunctUrl: "finalpage/2026-11-02/1225651111.PDF", secCode: "002594", secName: "比亚迪" }] })).toEqual([
      { date: "2026-11-02", title: "2026年10月产销快报", detail: "002594 比亚迪", url: "http://static.cninfo.com.cn/finalpage/2026-11-02/1225651111.PDF" },
    ]);
  });

  it("SEC full-text hits link to the document; without the relay nothing is called", async () => {
    expect(ftsRows({ hits: { hits: [{ _id: "0001234567-26-000123:ex99.htm", _source: { display_names: ["ACME CORP (ACME) (CIK 0000012345)"], form: "8-K", file_date: "2026-11-01", ciks: ["0000012345"] } }] } })[0]).toEqual({
      date: "2026-11-01", title: "8-K: ACME CORP (ACME) (CIK 0000012345)", detail: "ex99.htm", url: "https://www.sec.gov/Archives/edgar/data/12345/000123456726000123/ex99.htm",
    });
    const r = await secFullText("Acme Supplier", new Date(), {} as NodeJS.ProcessEnv);
    expect(r.error).toContain("relay");
  });

  it("older plans without the new lookups still parse", () => {
    const p = parsePlan(JSON.stringify({ title: "t", summary: "", companies: [], officials: [], programs: [], lookups: { contract_keywords: [], contract_recipients: [], lobbying_clients: [], pac_names: [], tickers: [] }, questions: [] }));
    expect(p.lookups.export_names).toEqual([]);
    expect(p.lookups.foreign_companies).toEqual([]);
  });
});

describe("following leads", () => {
  it("web search results and page text", () => {
    expect(braveHits({ web: { results: [{ title: "A &amp; <strong>B</strong>", url: "https://x.com/a", description: "one", extra_snippets: ["two"], age: "1 day ago" }, { title: "no url" }] } })).toEqual([{ title: "A & B", url: "https://x.com/a", snippet: "one two", age: "1 day ago" }]);
    expect(pageText("<html><nav>menu</nav><main><h1>Title</h1><p>Body text</p></main><footer>f</footer></html>")).toMatch(/Title\s+Body text/);
  });

  it("the next step: no repeats, only links it has seen, limits", () => {
    const trail: WebTrail = { rounds: [{ why: "", searches: [{ query: "Acme probe", hits: [] }], opened: [{ url: "https://a.com/1", kind: "html", text: "" }] }], stopped: "" };
    const seen = new Set(["https://a.com/1", "https://a.com/2", "https://a.com/3"]);
    const s = parseLeads(JSON.stringify({ why: "w", searches: ["acme probe", "Acme supplier", "x", "a", "b", "c"], open: ["https://a.com/1", "https://a.com/2", "https://made-up.com/9"], done: false }), trail, seen);
    expect(s.searches).toEqual(["Acme supplier"]); // the repeat (any case) and the too-short ones dropped
    expect(s.open).toEqual(["https://a.com/2"]);
    expect(parseLeads(JSON.stringify({ why: "", searches: [], open: [], done: false }), trail, seen).done).toBe(true);
  });

  it("links in text, and the trail as text for the report", () => {
    expect(linksIn("see https://a.com/x. and (https://b.org/y) end")).toEqual(["https://a.com/x", "https://b.org/y"]);
    const t = webText({ rounds: [{ why: "check", searches: [{ query: "q", hits: [{ title: "T", url: "https://a.com", snippet: "s", age: "" }] }], opened: [{ url: "https://a.com", kind: "pdf", text: "Doc text" }, { url: "https://b.com", kind: "error", error: "403" }] }], stopped: "done" });
    expect(t).toContain('ROUND 1 (check):\nSEARCH "q":\n- T: s (https://a.com)\nOPENED https://a.com (pdf):\nDoc text\nOPENED https://b.com: could not read (403)');
  });
});

describe("automatic investigations", () => {
  const now = new Date("2026-11-20T15:00:00Z");
  const item = (id: string, headline: string, over: Partial<FeedItem> = {}): FeedItem => ({ id, at: new Date(now.getTime() - 3600_000).toISOString(), headline, summary: "", source: "benzinga", url: `https://n.com/${id}`, symbols: ["ACME"], event: null, cardIds: [12], buzz: 1, score: 2, kind: "news", ...over });

  it("the triggers", () => {
    expect(autoTrigger("Hindenburg Research discloses short position in Acme")).toBe("short-seller report");
    expect(autoTrigger("Acme faces new US export controls on AI chips to China")).toBe("China / export controls");
    expect(autoTrigger("Commerce adds Acme supplier to Entity List")).toBe("China / export controls");
    expect(autoTrigger("SEC opens probe into Acme's revenue recognition")).toBe("regulators");
    expect(autoTrigger("Acme received a Wells notice")).toBe("regulators");
    expect(autoTrigger("Acme's CEO owns the landlord: related-party leases questioned")).toBe("related-party dealings");
    expect(autoTrigger("Acme beats estimates, raises guidance")).toBeNull();
    expect(autoTrigger("Acme opens a new store in Chinatown")).toBeNull();
  });

  it("picks the newest story on a card stock, skipping what was already investigated", () => {
    const items = [
      item("a", "SEC opens probe into Acme", { at: new Date(now.getTime() - 2 * 3600_000).toISOString() }),
      item("b", "Hindenburg shorts Beta", { symbols: ["BETA"] }),
      item("c", "Hindenburg shorts Gamma", { symbols: ["GAMMA"], cardIds: [] }), // no card
      item("d", "China bans Delta chips", { symbols: ["A", "B", "C", "D"] }), // a round-up
      item("e", "SEC probe of Old", { symbols: ["OLD"], at: new Date(now.getTime() - 30 * 3600_000).toISOString() }), // too old
    ];
    expect(pickStory(items, now, { symbols: new Set(), urls: new Set() })?.item.id).toBe("b");
    expect(pickStory(items, now, { symbols: new Set(["BETA"]), urls: new Set() })?.item.id).toBe("a");
    expect(pickStory(items, now, { symbols: new Set(["BETA", "ACME"]), urls: new Set() })).toBeNull();
  });

  it("the brief's first lines are how the cap and the cool-down recognise it", () => {
    const b = autoBrief(item("b", "Hindenburg shorts Beta", { symbols: ["BETA"] }), "short-seller report");
    expect(b.startsWith("Auto-investigation (short-seller report) of BETA: Hindenburg shorts Beta")).toBe(true);
    const done = alreadyDone([b, "Some story pasted by hand"]);
    expect([...done.symbols]).toEqual(["BETA"]);
    expect([...done.urls]).toEqual(["https://n.com/b"]);
  });
});
