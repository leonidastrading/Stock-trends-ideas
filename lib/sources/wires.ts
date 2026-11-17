/**
 * Fast news that does not depend on Alpaca's news stream: the press-release wires (where companies publish earnings
 * and other news the moment it is out), the SEC's live list of 8-K filings, and Finnhub's market news when a key is set.
 * Each source is best effort: one that fails or is slow is skipped. Items carry a US ticker or are dropped.
 */
import type { NewsItem } from "../alpaca";
import { getJson, getText } from "../http";
import { secTickerList } from "./edgar";
import { parseFeed } from "./site";

export const WIRES = [
  { name: "GlobeNewswire", url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies" },
  { name: "PR Newswire", url: "https://www.prnewswire.com/rss/news-releases-list.rss" },
];
const HALTS = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";
const SEC_CURRENT = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=60&output=atom";
const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" };

/** 8-K items worth a headline, in plain words. */
const ITEMS: Record<string, string> = {
  "1.01": "material agreement", "1.02": "agreement terminated", "1.05": "cybersecurity incident", "2.01": "acquisition or sale completed", "2.02": "results of operations (earnings)",
  "2.05": "restructuring costs", "2.06": "impairment", "3.01": "delisting notice", "4.01": "auditor change", "4.02": "past financials no longer reliable",
  "5.02": "officer or director change", "7.01": "Reg FD disclosure", "8.01": "other events",
};

/** Pure: the US ticker a press release names ("(NASDAQ: NVDA)", "NYSE:ABC"), or null. */
export function tickerInRelease(text: string): string | null {
  const m = /\b(?:NASDAQ|Nasdaq|NYSE(?:\s+American|\s+Arca)?|NYSE MKT|AMEX|Cboe(?:\s+BZX)?|CBOE)\s*(?:GS|GM|CM)?\s*:\s*\$?([A-Z]{1,5}(?:\.[A-Z])?)\b/.exec(text);
  return m ? m[1] : null;
}

/** Pure: a wire's feed items as news items (only those naming a US-listed ticker). */
export function wireItems(xml: string, source: string, base: string): NewsItem[] {
  return parseFeed(xml, base).flatMap((a) => {
    const sym = tickerInRelease(`${a.title} ${a.summary}`);
    if (!sym || !a.published) return [];
    return [{ id: hashId(a.url), ts: a.published, headline: a.title, summary: a.summary.slice(0, 600), symbols: [sym], source, url: a.url }];
  });
}

/** Pure: the SEC's live 8-K list as news items ("NVIDIA CORP files 8-K: results of operations (earnings)"). */
export function secItems(xml: string, tickerByCik: Map<string, string>): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const e = m[1];
    const title = /<title>([\s\S]*?)<\/title>/i.exec(e)?.[1] ?? "";
    const t = /^\s*8-K(?:\/A)?\s*-\s*(.*?)\s*\((\d{4,10})\)/.exec(title);
    if (!t) continue;
    const sym = tickerByCik.get(String(Number(t[2])));
    if (!sym) continue;
    const summary = (/<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(e)?.[1] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ");
    const items = [...new Set([...summary.matchAll(/Item\s+(\d\.\d\d)/g)].map((x) => x[1]))];
    const named = items.map((i) => ITEMS[i]).filter(Boolean);
    if (!named.length) continue;
    const ts = /<updated>([\s\S]*?)<\/updated>/i.exec(e)?.[1];
    const url = /<link[^>]*href="([^"]+)"/i.exec(e)?.[1] ?? "";
    if (!ts || !url) continue;
    const company = t[1].replace(/\s+/g, " ").trim();
    out.push({ id: hashId(url), ts: new Date(ts).toISOString(), headline: `${company} files 8-K: ${named.join("; ")}`, summary: `SEC filing, items ${items.join(", ")}.`, symbols: [sym], source: "SEC 8-K", url });
  }
  return out;
}

/** Nasdaq's halt reason codes, in plain words. */
const HALT_REASON: Record<string, string> = {
  T1: "news pending", T2: "news released", T3: "news and resumption times", T5: "single-stock trading pause", T6: "extraordinary market activity", T8: "ETF",
  T12: "additional information requested", H4: "not in compliance", H9: "not current in filings", H10: "SEC trading suspension", H11: "regulatory concern",
  LUDP: "volatility pause (limit up-limit down)", LUDS: "volatility pause (straddle)", MWC1: "market-wide circuit breaker", M: "volatility pause", IPO1: "IPO not yet trading", MCB3: "market-wide circuit breaker",
};

/** Pure: an ET date and time ("11/17/2026", "15:58:02") as ISO. */
export function etToIso(date: string, time: string): string | null {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim()), t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time.trim());
  if (!d || !t) return null;
  for (const offset of [5, 4]) {
    const guess = new Date(Date.UTC(Number(d[3]), Number(d[1]) - 1, Number(d[2]), Number(t[1]) + offset, Number(t[2]), Number(t[3] ?? 0)));
    const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(guess);
    if (Number(et) === Number(t[1])) return guess.toISOString();
  }
  return null;
}

/** Pure: Nasdaq's live trading-halt feed as news items ("Trading halted: XYZ (news pending)"). */
export function haltItems(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  const tagOf = (s: string, n: string) => new RegExp(`<ndaq:${n}>([\\s\\S]*?)</ndaq:${n}>`, "i").exec(s)?.[1]?.trim() ?? "";
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const sym = tagOf(it, "IssueSymbol").toUpperCase();
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(sym)) continue;
    const ts = etToIso(tagOf(it, "HaltDate"), tagOf(it, "HaltTime"));
    if (!ts) continue;
    const code = tagOf(it, "ReasonCode");
    const name = tagOf(it, "IssueName");
    const resume = tagOf(it, "ResumptionTradeTime");
    const why = HALT_REASON[code] ?? code;
    out.push({ id: hashId(`halt:${sym}:${ts}`), ts, headline: `Trading halted: ${sym}${name ? ` (${name})` : ""}, ${why}${resume ? `; resumes ${resume} ET` : ""}`, summary: `Nasdaq halt, reason code ${code}.`, symbols: [sym], source: "Nasdaq halts", url: `https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts` });
  }
  return out;
}

/** Pure: a stable numeric id from a URL (the feed's own ids are not numbers). */
function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return 9e12 + Math.abs(h); // far from Alpaca's ids
}

/** The fast sources' last-day items. Never throws. */
export async function fastNews(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch, now = new Date()): Promise<NewsItem[]> {
  const since = now.getTime() - 24 * 3600_000;
  const jobs: Array<Promise<NewsItem[]>> = WIRES.map((w) => getText(w.url, { headers: UA, fetchImpl, cacheMs: 10_000, timeoutMs: 6000, retries: 0 }).then((x) => wireItems(x, w.name, w.url)).catch(() => []));
  jobs.push(getText(HALTS, { headers: UA, fetchImpl, cacheMs: 10_000, timeoutMs: 6000, retries: 0 }).then(haltItems).catch(() => []));
  const ua = env.SEC_USER_AGENT?.trim();
  if (ua) {
    jobs.push((async () => {
      const [xml, list] = await Promise.all([
        getText(SEC_CURRENT, { headers: { "user-agent": ua, accept: "application/atom+xml" }, fetchImpl, cacheMs: 10_000, timeoutMs: 6000, retries: 0 }),
        secTickerList(ua, fetchImpl),
      ]);
      return secItems(xml, new Map(list.map((x) => [x.cik, x.ticker])));
    })().catch(() => []));
  }
  const key = env.FINNHUB_API_KEY?.trim();
  if (key) {
    jobs.push(getJson<Array<{ id: number; datetime: number; headline: string; summary?: string; source?: string; url: string; related?: string }>>("https://finnhub.io/api/v1/news?category=general", { headers: { "X-Finnhub-Token": key, accept: "application/json" }, fetchImpl, cacheMs: 10_000, timeoutMs: 6000, retries: 0 })
      .then((list) => list.map((n) => ({ id: 8e12 + n.id, ts: new Date(n.datetime * 1000).toISOString(), headline: n.headline, summary: (n.summary ?? "").slice(0, 600), symbols: (n.related ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)), source: n.source || "Finnhub", url: n.url })))
      .catch(() => []));
  }
  return (await Promise.all(jobs)).flat().filter((n) => Date.parse(n.ts) >= since && Date.parse(n.ts) <= now.getTime() + 120_000);
}
