import { describe, expect, it } from "vitest";
import { fastNews, secItems, tickerInRelease, wireItems } from "@/lib/sources/wires";

const GNW = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>GlobeNewswire</title>
<item><title>NVIDIA Announces Financial Results for Third Quarter Fiscal 2027</title><link>https://www.globenewswire.com/news-release/2026/11/17/1/0/en/nvidia-results.html</link><description>SANTA CLARA, Calif., Nov. 17, 2026 (GLOBE NEWSWIRE) -- NVIDIA (NASDAQ: NVDA) today reported revenue of $115.8 billion...</description><pubDate>Tue, 17 Nov 2026 21:20:00 GMT</pubDate></item>
<item><title>Private Co raises seed round</title><link>https://www.globenewswire.com/x</link><description>No ticker here.</description><pubDate>Tue, 17 Nov 2026 21:10:00 GMT</pubDate></item>
</channel></rss>`;

const SEC = `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title>
<entry><title>8-K - NVIDIA CORP (0001045810) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1045810/000104581026000099/0001045810-26-000099-index.htm"/><summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-11-17 &lt;b&gt;AccNo:&lt;/b&gt; 0001045810-26-000099 &lt;b&gt;Size:&lt;/b&gt; 1 MB&lt;br&gt;Item 2.02: Results of Operations and Financial Condition&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary><updated>2026-11-17T16:21:05-05:00</updated></entry>
<entry><title>8-K - UNKNOWN SHELL CO (0009999999) (Filer)</title><link href="https://www.sec.gov/x"/><summary>Item 8.01: Other Events</summary><updated>2026-11-17T16:20:00-05:00</updated></entry>
<entry><title>8-K - SOMECO (0000000123) (Filer)</title><link href="https://www.sec.gov/y"/><summary>Item 9.01: Financial Statements and Exhibits</summary><updated>2026-11-17T16:19:00-05:00</updated></entry>
</feed>`;

describe("fast news sources", () => {
  it("finds the ticker a press release names", () => {
    expect(tickerInRelease("NVIDIA (NASDAQ: NVDA) today reported")).toBe("NVDA");
    expect(tickerInRelease("Acme Corp. (NYSE American: ACU) said")).toBe("ACU");
    expect(tickerInRelease("Beta (Nasdaq: BETA) and others")).toBe("BETA");
    expect(tickerInRelease("a private company")).toBeNull();
  });

  it("reads a wire's feed, keeping only listed companies", () => {
    const items = wireItems(GNW, "GlobeNewswire", "https://www.globenewswire.com/");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ headline: "NVIDIA Announces Financial Results for Third Quarter Fiscal 2027", symbols: ["NVDA"], source: "GlobeNewswire", ts: "2026-11-17T21:20:00.000Z" });
  });

  it("reads the SEC's live 8-K list into headlines, by ticker, skipping exhibit-only filings and unknown companies", () => {
    const items = secItems(SEC, new Map([["1045810", "NVDA"], ["123", "SOME"]]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ headline: "NVIDIA CORP files 8-K: results of operations (earnings)", symbols: ["NVDA"], source: "SEC 8-K", ts: "2026-11-17T21:21:05.000Z" });
  });

  it("gathers the sources in parallel and drops anything older than a day", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("globenewswire")) return new Response(GNW);
      if (url.includes("prnewswire")) return new Response("down", { status: 503 });
      if (url.includes("company_tickers")) return Response.json({ 0: { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" } });
      if (url.includes("getcurrent")) return new Response(SEC);
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const items = await fastNews({ SEC_USER_AGENT: "test agent@example.com" } as unknown as NodeJS.ProcessEnv, fetchImpl, new Date("2026-11-17T21:30:00Z"));
    expect(items.map((i) => i.source).sort()).toEqual(["GlobeNewswire", "SEC 8-K"]);
    expect(await fastNews({} as NodeJS.ProcessEnv, fetchImpl, new Date("2026-11-20T21:30:00Z"))).toEqual([]);
  });
});
