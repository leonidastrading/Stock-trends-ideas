/**
 * Court: lawsuits that can move a listed stock, from free public sources.
 *
 * - Securities class actions, from the law firms' "lead plaintiff deadline" releases (one case is announced by a dozen
 *   firms; they are folded into one row per stock, with how many releases and the deadline). The Stanford Securities
 *   Class Action Clearinghouse is not used: it blocks servers and its list stopped in July 2025.
 * - ITC Section 337 patent cases (the US International Trade Commission can ban imports of an infringing product),
 *   from the Federal Register's notices: new complaints, new investigations, rulings, exclusion orders. The ITC's own
 *   site blocks servers.
 * - Federal court dockets (CourtListener) need a free API key and are not read yet.
 */
import { decodeEntities } from "../entities";
import { getText } from "../http";
import { sponsorMatcher } from "./pharma";

const UA = { "user-agent": "Mozilla/5.0 (compatible; trend-scout research)" };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const decode = (s: string) => decodeEntities(s);

/** Pure: "December 7, 2026" → "2026-12-07". */
export function isoFromWords(s: string): string | null {
  const m = /([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  return mi < 0 ? null : `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// ------------------------------------------------------------ class actions

export interface ClassActionRelease { at: string; headline: string; url: string; source: string }
export interface ClassActionCase { symbol: string; company: string; deadline: string | null; releases: number; firms: string[]; firstSeen: string; lastSeen: string; headlines: Array<{ at: string; headline: string; url: string }> }

const DATE_WORDS = /([A-Z][a-z]+\.?\s+\d{1,2},\s*\d{4})/;
const FIRMS = /\b(Rosen|Robbins|Levi & Korsinsky|Pomerantz|Bronstein|Glancy|Kessler Topaz|Faruqi|Bragar|Kaplan Fox|Schall|Gross|Hagens Berman|Bernstein Liebhard|Johnson Fistel|Holzer|Portnoy|Frank R\. Cruz|Howard G\. Smith|SueWallSt|Block & Leviton|Labaton|Saxena White|Kirby McInerney|Bleichmar|Edelson|Berger Montague|Scott\+Scott|Hagens|Wolf Haldenstein|DJS Law|Rigrodsky|Brodsky & Smith|Halper Sadeh|Monteverde|Ademi|Kahn Swick|Lieff Cabraser)\b/i;

/** Pure: the stock a class-action release is about (exchange tag first, then the ticker forms the firms use). */
export function classActionTicker(headline: string, known: Set<string>): string | null {
  const h = decode(headline);
  const tries = [
    ...[...h.matchAll(/\((?:NASDAQ|NYSE|NYSE American|NYSE Arca|AMEX|Nasdaq|NasdaqGS|NasdaqGM|OTC)\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\)/g)].map((m) => m[1]),
    ...[...h.matchAll(/\s[-–]\s([A-Z]{1,5})(?=\s[-–]\s|$)/g)].map((m) => m[1]),
    /^([A-Z]{1,5})\s+(?:Lead Plaintiff|Shareholder|Investor|Stockholder|Class Action|Securities|Deadline|INVESTOR|SHAREHOLDER|CLASS|LAWSUIT)/.exec(h)?.[1],
    /\bReminds\s+([A-Z]{1,5})\s+(?:Investors|Shareholders|Stockholders)/.exec(h)?.[1],
    /\(([A-Z]{2,5})\)/.exec(h)?.[1],
  ].filter((x): x is string => !!x);
  return tries.find((t) => known.has(t)) ?? null;
}

/** Pure: the company named in a release ("in Lennar Corporation Lawsuit", "for Duolingo, Inc."), for name matching. */
export function classActionCompany(headline: string): string | null {
  const h = decode(headline);
  const m = /\b(?:in|for|against|Against|Reminds)\s+([A-Z][\w.&',\- ]{2,60}?(?:Inc\.?|Corporation|Corp\.?|Company|Co\.|Holdings?|Group|Ltd\.?|plc|N\.V\.|S\.A\.|Limited|Technologies|Therapeutics|Pharmaceuticals|Bancorp))(?=[\s,):;]|$)/.exec(h);
  return m ? m[1].trim() : null;
}

/** Pure: SEC registrant names without their state tags ("LENNAR CORP /NEW/", "O-I Glass, Inc. /DE/"). */
export const cleanTitles = (companies: Array<{ ticker: string; title: string }>) => companies.map((c) => ({ ...c, title: c.title.replace(/\s*\/[A-Za-z]{1,6}\/?\s*$/, "") }));

/** Pure: releases folded into one case per stock (deadline: the latest one mentioned), most releases first. */
export function classActionCases(items: ClassActionRelease[], companies: Array<{ ticker: string; title: string }>): ClassActionCase[] {
  const known = new Set(companies.map((c) => c.ticker));
  const byName = sponsorMatcher(cleanTitles(companies));
  const title = new Map(companies.map((c) => [c.ticker, c.title]));
  const cases = new Map<string, ClassActionCase>();
  const seen = new Set<string>();
  for (const it of items) {
    const h0 = decode(it.headline);
    const h = it.source && h0.endsWith(` - ${it.source}`) ? h0.slice(0, -(it.source.length + 3)) : h0; // without " - Outlet"
    if (!/lead plaintiff|class action|securities fraud|securities lawsuit|investors who lost|filed against/i.test(h)) continue;
    const key = h.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const company = classActionCompany(h);
    const sym = classActionTicker(h, known) ?? (company ? byName(company) : null);
    if (!sym) continue;
    const deadline = /lead plaintiff/i.test(h) ? isoFromWords(DATE_WORDS.exec(h)?.[1] ?? "") : null;
    const firm = FIRMS.exec(h)?.[1] ?? null;
    const c = cases.get(sym) ?? { symbol: sym, company: title.get(sym) ?? company ?? sym, deadline: null, releases: 0, firms: [], firstSeen: it.at, lastSeen: it.at, headlines: [] };
    c.releases++;
    if (deadline && (!c.deadline || deadline > c.deadline)) c.deadline = deadline;
    if (firm && !c.firms.some((f) => f.toLowerCase() === firm.toLowerCase())) c.firms.push(firm);
    if (it.at < c.firstSeen) c.firstSeen = it.at;
    if (it.at > c.lastSeen) c.lastSeen = it.at;
    c.headlines.push({ at: it.at, headline: h, url: it.url });
    cases.set(sym, c);
  }
  for (const c of cases.values()) c.headlines.sort((a, b) => b.at.localeCompare(a.at)).splice(5);
  return [...cases.values()].sort((a, b) => b.lastSeen.slice(0, 10).localeCompare(a.lastSeen.slice(0, 10)) || b.releases - a.releases);
}

/** Pure: a Google News RSS feed as releases. */
export function rssItems(xml: string): ClassActionRelease[] {
  const tag = (x: string, n: string) => x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i"))?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() ?? "";
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
    const t = Date.parse(tag(m[1], "pubDate"));
    return { at: Number.isFinite(t) ? new Date(t).toISOString() : "", headline: decode(tag(m[1], "title")), url: decode(tag(m[1], "link")), source: decode(tag(m[1], "source")) || "news" };
  }).filter((e) => e.headline && e.at);
}

/** The last two weeks' class-action releases from Google News (several searches, duplicates dropped). */
export async function fetchClassActions(companies: Array<{ ticker: string; title: string }>, fetchImpl?: typeof fetch): Promise<ClassActionCase[]> {
  const queries = ['"lead plaintiff deadline" when:14d', '"securities class action" when:14d', '"class action lawsuit has been filed" when:14d', '"securities fraud lawsuit" when:14d'];
  const items: ClassActionRelease[] = [];
  for (const q of queries) {
    const xml = await getText(`https://news.google.com/rss/search?${new URLSearchParams({ q, hl: "en-US", gl: "US", ceid: "US:en" })}`, { headers: UA, fetchImpl, cacheMs: 60 * 60_000, timeoutMs: 10_000, retries: 1, minIntervalMs: 300 }).catch(() => "");
    if (xml) items.push(...rssItems(xml));
  }
  if (!items.length) throw new Error("Google News returned nothing");
  return classActionCases(items, companies);
}

// ------------------------------------------------------------------- ITC 337

export type ItcStage = "complaint" | "instituted" | "initial ruling" | "review" | "final ruling" | "exclusion order" | "ended" | "other";
export interface ItcNotice {
  date: string; stage: ItcStage; title: string; product: string; investigation: string | null; url: string;
  complainants: string[]; respondents: string[]; complainantTickers: string[]; respondentTickers: string[];
}

/** Pure: what kind of step a notice is. */
export function itcStage(title: string): ItcStage {
  const t = title.toLowerCase();
  if (/exclusion order|cease and desist/.test(t)) return "exclusion order";
  if (/final determination|final initial determination.*review|commission'?s? final/.test(t)) return "final ruling";
  if (/terminat|withdraw|settlement|consent order/.test(t)) return "ended";
  if (/institution of investigation/.test(t)) return "instituted";
  if (/receipt of complaint/.test(t)) return "complaint";
  if (/determination (not )?to review|to review/.test(t)) return "review";
  if (/initial determination/.test(t)) return "initial ruling";
  return "other";
}

const ENTITY = /([A-Z][\w.&'’\-]*(?:\s+(?:[A-Z][\w.&'’\-]*|\([^)]{1,40}\)|&|and|of|de|du|the))*?,?\s+(?:Inc\.|Inc|Corporation|Corp\.|Company|Co\.,\s*Ltd\.|Co\.\s*Ltd\.|Ltd\.|LLC|L\.L\.C\.|Limited|GmbH|AG|S\.A\.|SA|plc|PLC|N\.V\.|B\.V\.|K\.K\.|Pte\.\s*Ltd\.|S\.p\.A\.|AB|ASA|Oy|SE))(?=[\s,;.]|$)/g;

/** Pure: company names in a passage ("Apple. Inc." read as Apple Inc.). */
export function entities(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(/\bApple\.\s+Inc/g, "Apple Inc").matchAll(ENTITY)) {
    const n = m[1].replace(/^(?:and|the|of)\s+/i, "").trim();
    if (!out.includes(n) && !/^(Certain|Notice|Section|The Commission|United States|Office|Unfair)/.test(n)) out.push(n);
  }
  return out.slice(0, 30);
}

/** Pure: complainants and respondents from a notice's text. */
export function itcParties(text: string): { complainants: string[]; respondents: string[] } {
  const t = text.replace(/\s+/g, " ");
  const comp = /complainant(?:s)? (?:is|are)[:\s]+(.{0,600}?)(?:\(b\)|\(c\)|The respondents?)/i.exec(t)?.[1]
    ?? /on behalf of (.{0,300}?)(?:\.\s|;)/i.exec(t)?.[1] ?? "";
  const resp = /respondents? (?:are|is) the following[^:]*:(.{0,3000}?)(?:\(c\)|\(d\)|\(4\)|Responses to the complaint)/i.exec(t)?.[1]
    ?? /names? as (?:a )?respondents?[:\s]+(.{0,1500}?)(?:\.\s+The complainant|\.\s+Proposed|\. The proposed|$)/i.exec(t)?.[1] ?? "";
  return { complainants: entities(comp), respondents: entities(resp) };
}

/** Pure: a Federal Register notice as an ITC case step, its parties matched to US tickers. */
export function itcNotice(doc: { title: string; publication_date: string; html_url: string; abstract?: string | null; docket_ids?: string[] }, text: string, match: (name: string) => string | null): ItcNotice {
  const parties = itcParties(text || doc.abstract || "");
  const product = (/complaint entitled (Certain [^,;]+)/i.exec(`${doc.abstract ?? ""} ${text}`)?.[1] ?? (/^(Certain [^;]+)/.exec(doc.title)?.[1] ?? doc.title)).trim();
  const inv = (doc.docket_ids ?? []).map((d) => /337-TA-\d+/.exec(d)?.[0]).find(Boolean) ?? /337-TA-\d+/.exec(text)?.[0] ?? /DN \d+/.exec(`${doc.abstract ?? ""} ${text}`)?.[0] ?? null;
  const tick = (xs: string[]) => [...new Set(xs.map(match).filter((x): x is string => !!x))];
  return { date: doc.publication_date, stage: itcStage(doc.title), title: doc.title, product, investigation: inv, url: doc.html_url, ...parties, complainantTickers: tick(parties.complainants), respondentTickers: tick(parties.respondents) };
}

/** The last 90 days of ITC Section 337 notices from the Federal Register, with their full text read for the parties. */
export async function fetchItcNotices(today: string, companies: Array<{ ticker: string; title: string }>, fetchImpl?: typeof fetch, max = 60): Promise<ItcNotice[]> {
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 90 * 86400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({ "conditions[agencies][]": "international-trade-commission", "conditions[term]": '"section 337"', "conditions[publication_date][gte]": since, order: "newest", per_page: String(max) });
  for (const f of ["title", "publication_date", "html_url", "abstract", "docket_ids", "raw_text_url"]) params.append("fields[]", f);
  const j = JSON.parse(await getText(`https://www.federalregister.gov/api/v1/documents.json?${params}`, { headers: UA, fetchImpl, cacheMs: 6 * 60 * 60_000, timeoutMs: 15_000, retries: 1 })) as { results?: Array<{ title: string; publication_date: string; html_url: string; abstract?: string | null; docket_ids?: string[]; raw_text_url?: string }> };
  const match = sponsorMatcher(cleanTitles(companies));
  const out: ItcNotice[] = [];
  for (const d of j.results ?? []) {
    const text = d.raw_text_url ? await getText(d.raw_text_url, { headers: UA, fetchImpl, cacheMs: 7 * 86400_000, timeoutMs: 10_000, retries: 1, minIntervalMs: 200 }).catch(() => "") : "";
    out.push(itcNotice(d, text, match));
  }
  return out;
}
