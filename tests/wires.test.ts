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

describe("trading halts and phone alerts", async () => {
  const { etToIso, haltItems } = await import("@/lib/sources/wires");
  const { pickAlerts } = await import("@/lib/scout/news-alerts");
  const HALT = `<rss xmlns:ndaq="http://www.nasdaqtrader.com/"><channel><item><title>XYZ</title><ndaq:HaltDate>11/17/2026</ndaq:HaltDate><ndaq:HaltTime>15:58:02</ndaq:HaltTime><ndaq:IssueSymbol>URGN</ndaq:IssueSymbol><ndaq:IssueName>UroGen Pharma Ltd</ndaq:IssueName><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>T1</ndaq:ReasonCode><ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime></item></channel></rss>`;

  it("converts Eastern time, winter and summer", () => {
    expect(etToIso("11/17/2026", "15:58:02")).toBe("2026-11-17T20:58:02.000Z");
    expect(etToIso("07/01/2026", "09:30:00")).toBe("2026-07-01T13:30:00.000Z");
  });

  it("reads Nasdaq's halt feed", () => {
    expect(haltItems(HALT)[0]).toMatchObject({ headline: "Trading halted: URGN (UroGen Pharma Ltd), news pending", symbols: ["URGN"], source: "Nasdaq halts", ts: "2026-11-17T20:58:02.000Z" });
  });

  it("alerts new halts, filings, releases and event headlines on your stocks, once, most urgent first", () => {
    const now = new Date("2026-11-17T21:05:00Z");
    const n = (o: Record<string, unknown>) => ({ id: 1, ts: "2026-11-17T21:00:00Z", headline: "h", summary: "", symbols: ["NVDA"], source: "fiscal.ai", url: "https://x/1", ...o });
    const items = [
      n({ headline: "NVIDIA beats estimates", url: "https://x/a" }),
      n({ headline: "NVIDIA CORP files 8-K: results of operations (earnings)", source: "SEC 8-K", url: "https://sec/1" }),
      ...haltItems(HALT),
      n({ headline: "Nvidia stock is popular", url: "https://x/b" }), // no event word
      n({ headline: "Apple beats estimates", symbols: ["AAPL"], url: "https://x/c" }), // not yours
      n({ headline: "Old news beats", ts: "2026-11-17T19:00:00Z", url: "https://x/d" }), // too old
    ];
    const picks = pickAlerts(items, new Set(["NVDA", "URGN"]), new Set(), now);
    // One push per stock per run: NVDA's filing now, its headline on the next run.
    expect(picks.map((p) => [p.symbol, p.why])).toEqual([["URGN", "halt"], ["NVDA", "filing"]]);
    const next = pickAlerts(items, new Set(["NVDA", "URGN"]), new Set(picks.map((p) => p.key)), now);
    expect(next.map((p) => [p.symbol, p.why])).toEqual([["NVDA", "beats estimates"]]);
    expect(pickAlerts(items, new Set(["NVDA", "URGN"]), new Set([...picks, ...next].flatMap((p) => [p.key, ...(p.cooldown ? [`story:${p.symbol}:${Math.floor(now.getTime() / 7200_000)}`] : [])])), now)).toHaveLength(0);
  });

  it("a big company's big story alerts without a card; one outlet, a quiet headline or a volatility pause does not", () => {
    const now = new Date("2026-11-19T16:05:00Z");
    const n = (o: Record<string, unknown>) => ({ id: 1, ts: "2026-11-19T16:00:00Z", headline: "h", summary: "", symbols: ["AMD"], source: "fiscal.ai", url: `https://x/${Math.random()}`, ...o });
    const amd = [n({ headline: "AMD to acquire chip startup in $4B deal" }), n({ headline: "AMD agrees to $4 billion acquisition", source: "PR Newswire" }), n({ headline: "AMD shares climb on deal", source: "Benzinga" })];
    const one = pickAlerts(amd, new Set(), new Set(), now);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ symbol: "AMD", why: "deal", bigStory: true });
    // Only one outlet so far: not yet.
    expect(pickAlerts(amd.slice(0, 1), new Set(), new Set(), now)).toHaveLength(0);
    // Once alerted, the other outlets' copies stay quiet for two hours.
    expect(pickAlerts(amd, new Set(), new Set([`story:AMD:${Math.floor(now.getTime() / 7200_000)}`]), now)).toHaveLength(0);
    // A small stock needs three outlets.
    const tiny = (src: string) => n({ headline: "Tiny Co announces merger", symbols: ["TINY"], source: src });
    expect(pickAlerts([tiny("a"), tiny("b")], new Set(), new Set(), now)).toHaveLength(0);
    expect(pickAlerts([tiny("a"), tiny("b"), tiny("c")], new Set(), new Set(), now)[0]).toMatchObject({ symbol: "TINY", bigStory: true });
    // A routine volatility pause never alerts, even on your stock.
    const pause = n({ headline: "Trading halted: TDTH, volatility pause (limit up-limit down)", summary: "Nasdaq halt, reason code LUDP.", source: "Nasdaq halts", symbols: ["TDTH"] });
    expect(pickAlerts([pause], new Set(["TDTH"]), new Set(), now)).toHaveLength(0);
  });
});

describe("world news: BBC and Al Jazeera", async () => {
  const { worldItems } = await import("@/lib/sources/wires");
  const { isMainstream } = await import("@/lib/sources/news");
  it("reads world headlines without tickers, and counts the outlets as mainstream", () => {
    const xml = `<rss><channel><item><title>Japan scrambles jets as Russian aircraft violate airspace near Okinoshima</title><link>https://www.aljazeera.com/news/2026/11/17/japan-jets</link><description>Tokyo protested to Moscow.</description><pubDate>Tue, 17 Nov 2026 22:00:00 GMT</pubDate></item></channel></rss>`;
    const [n] = worldItems(xml, "Al Jazeera", "https://www.aljazeera.com/");
    expect(n).toMatchObject({ source: "Al Jazeera", symbols: [], headline: "Japan scrambles jets as Russian aircraft violate airspace near Okinoshima" });
    expect(isMainstream(n)).toBe(true);
    expect(isMainstream({ ...n, source: "BBC", url: "https://www.bbc.co.uk/news/world-asia-1" })).toBe(true);
  });
});
