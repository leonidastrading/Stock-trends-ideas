/**
 * SEC filings the news playbook singles out, read from EDGAR's public archive
 * (www.sec.gov, declared User-Agent, under 8 requests a second):
 *
 * - Form 4 open-market purchases (code P) by insiders. Opportunistic buys (not
 *   the insider's usual calendar month) earned ~0.8%/month for ~6 months with
 *   no reversal (Cohen, Malloy & Pomorski 2012); markets underreact to them.
 * - New Schedule 13D activist stakes: drift for weeks, no reversal (Brav et al. 2008).
 * - 8-K items that flag bad news: non-reliance (4.02), auditor change (4.01),
 *   cybersecurity incident (1.05), impairment (2.06), restructuring (2.05),
 *   officer departures (5.02).
 *
 * Daily form index → queue → per-filing fetch (Form 4 XML, or the SEC header
 * for 8-K items and 13D subject company). Pure parsers here; IO is small.
 */
import { getText } from "../http";

export const SEC_ARCHIVE = "https://www.sec.gov/Archives";
export const SEC_INTERVAL_MS = 130;

export interface IndexEntry { form: string; company: string; cik: string; filed: string; path: string; accession: string }

/** Pure: the daily form index ("form.YYYYMMDD.idx"), keeping only the forms asked for, one row per filing. */
export function parseFormIndex(text: string, forms: (form: string) => boolean): IndexEntry[] {
  const out = new Map<string, IndexEntry>();
  for (const line of text.split("\n")) {
    const m = /^(\S+(?: \S+)*?)\s{2,}(.+?)\s{2,}(\d{1,10})\s+(\d{8})\s+(edgar\/data\/\S+\.txt)\s*$/.exec(line);
    if (!m || !forms(m[1])) continue;
    const accession = m[5].replace(/^.*\//, "").replace(/\.txt$/, "");
    if (!out.has(accession)) out.set(accession, { form: m[1], company: m[2].trim(), cik: m[3], filed: `${m[4].slice(0, 4)}-${m[4].slice(4, 6)}-${m[4].slice(6, 8)}`, path: m[5], accession });
  }
  return [...out.values()];
}

export const WANTED_FORMS = (f: string) => f === "4" || f === "8-K" || f === "SCHEDULE 13D" || f === "SC 13D";

export function indexUrl(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${SEC_ARCHIVE}/edgar/daily-index/${y}/QTR${Math.ceil(m / 3)}/form.${date.replace(/-/g, "")}.idx`;
}

export function headerUrl(e: { path: string; accession: string }): string {
  const cik = e.path.split("/")[2];
  return `${SEC_ARCHIVE}/edgar/data/${cik}/${e.accession.replace(/-/g, "")}/${e.accession}-index-headers.html`;
}

// ------------------------------------------------------------------ Form 4

export interface InsiderBuy {
  issuerCik: string; issuerName: string; symbol: string; owner: string; ownerCik: string; role: string;
  date: string; shares: number; price: number; value: number; ownedAfter: number | null; pctIncrease: number | null; plan10b5: boolean;
  /** Top executive (CEO, CFO, COO, president, chair) vs everyone else (directors, other officers, 10% owners). */
  executive: boolean;
  /** Home state of the insider's own address and the company's business address; local = same state, and not just the company's address. */
  ownerState: string | null; issuerState: string | null; local: boolean | null;
}

/** Pure: the CEO / CFO / COO / president / chair, the "executive" insiders of Cohen, Malloy & Pomorski. */
export const isExecutive = (role: string) => /\b(chief|ceo|cfo|coo|president|chair(man|woman|person)?)\b/i.test(role);

const street = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(c o|suite|ste|floor|fl)\b.*$/, "").trim();

/** Pure: the company's business-address state and street from the SEC header of a Form 4 submission. */
export function issuerAddress(text: string): { state: string | null; street: string | null } {
  const block = /ISSUER:([\s\S]*?)(?:REPORTING-OWNER:|<\/SEC-HEADER>|<DOCUMENT>|$)/.exec(text)?.[1] ?? "";
  const biz = /BUSINESS ADDRESS:([\s\S]*?)(?:MAIL ADDRESS:|FORMER COMPANY:|$)/.exec(block)?.[1] ?? "";
  return { state: /STATE:\s*([A-Z]{2})\b/.exec(biz)?.[1] ?? null, street: /STREET 1:\s*(.+)/.exec(biz)?.[1]?.trim() ?? null };
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*(?:<value>)?\\s*([^<]*)`, "i").exec(xml)?.[1]?.trim() ?? "";

/** Pure: open-market purchases (code P, acquired) in a Form 4, summed per filing. Null when there are none. */
export function parseForm4(text: string): InsiderBuy | null {
  const xml = /<ownershipDocument>[\s\S]*<\/ownershipDocument>/i.exec(text)?.[0];
  if (!xml) return null;
  const txs = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)].map((m) => m[1]);
  let shares = 0, value = 0, date = "", ownedAfter: number | null = null;
  for (const t of txs) {
    if (tag(t, "transactionCode") !== "P" || tag(t, "transactionAcquiredDisposedCode") !== "A") continue;
    const sh = Number(tag(t, "transactionShares")), px = Number(tag(t, "transactionPricePerShare"));
    if (!(sh > 0) || !(px > 0)) continue;
    shares += sh;
    value += sh * px;
    date = tag(t, "transactionDate").slice(0, 10) || date;
    const after = Number(tag(t, "sharesOwnedFollowingTransaction"));
    if (after > 0) ownedAfter = after;
  }
  if (!shares) return null;
  const roles = [/true|1/i.test(tag(xml, "isDirector")) ? "director" : "", /true|1/i.test(tag(xml, "isOfficer")) ? tag(xml, "officerTitle") || "officer" : "", /true|1/i.test(tag(xml, "isTenPercentOwner")) ? "10% owner" : ""].filter(Boolean);
  const before = ownedAfter !== null ? ownedAfter - shares : null;
  const ownerAddr = /<reportingOwnerAddress>([\s\S]*?)<\/reportingOwnerAddress>/i.exec(xml)?.[1] ?? "";
  const ownerState = (/<rptOwnerState>\s*([A-Za-z]{2})\s*</i.exec(ownerAddr)?.[1] ?? "").toUpperCase() || null;
  const ownerStreet = /<rptOwnerStreet1>\s*([^<]*)</i.exec(ownerAddr)?.[1]?.trim() ?? "";
  const issuer = issuerAddress(text);
  // An insider who files from the company's own address tells us nothing about where they live.
  const companyAddress = !!ownerStreet && !!issuer.street && street(ownerStreet) === street(issuer.street);
  const roleText = roles.join(", ") || "other";
  return {
    issuerCik: tag(xml, "issuerCik").replace(/^0+/, ""), issuerName: tag(xml, "issuerName"), symbol: tag(xml, "issuerTradingSymbol").toUpperCase().replace(/[^A-Z.]/g, ""),
    owner: tag(xml, "rptOwnerName"), ownerCik: tag(xml, "rptOwnerCik").replace(/^0+/, ""), role: roleText,
    date, shares, price: Math.round((value / shares) * 100) / 100, value: Math.round(value), ownedAfter,
    pctIncrease: before !== null && before > 0 ? Math.round((shares / before) * 1000) / 10 : null,
    plan10b5: /true|1/i.test(tag(xml, "aff10b5One")),
    executive: isExecutive(roleText), ownerState, issuerState: issuer.state,
    local: ownerState && issuer.state && !companyAddress ? ownerState === issuer.state : null,
  };
}

/**
 * Pure: routine (Cohen, Malloy & Pomorski) = the insider filed Form 4s in the
 * same calendar month in each of the three previous years. Null without history.
 */
export function isRoutine(ownerForm4Dates: string[], date: string): boolean | null {
  if (!ownerForm4Dates.length) return null;
  const y = Number(date.slice(0, 4)), m = date.slice(5, 7);
  const has = (yy: number) => ownerForm4Dates.some((d) => d.startsWith(`${yy}-${m}`));
  return has(y - 1) && has(y - 2) && has(y - 3);
}

// ----------------------------------------------------------- 8-K and 13D headers

export const SERIOUS_ITEMS: Array<{ item: string; label: string; re: RegExp; research: boolean }> = [
  { item: "4.02", label: "non-reliance on past financial statements", re: /Non-Reliance on Previously Issued/i, research: true },
  { item: "1.05", label: "material cybersecurity incident", re: /Material Cybersecurity Incident/i, research: true },
  { item: "4.01", label: "auditor change", re: /Changes? in Registrant.s Certifying Accountant/i, research: false },
  { item: "2.06", label: "material impairment", re: /Material Impairments?/i, research: false },
  { item: "2.05", label: "restructuring / exit costs", re: /Costs Associated with Exit or Disposal/i, research: false },
  { item: "5.02", label: "director or officer departure", re: /Departure of Directors or (?:Certain )?Officers/i, research: false },
];

export interface Header { form: string; items: string[]; subject: { name: string; cik: string } | null; filedBy: { name: string; cik: string } | null; filer: { name: string; cik: string } | null }

/** Pure: the SEC header of a filing (from -index-headers.html). */
export function parseHeader(html: string): Header {
  const t = html.replace(/<[^>]*>/g, "").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const block = (label: string) => {
    const m = new RegExp(`${label}:\\s*[\\s\\S]*?COMPANY CONFORMED NAME:\\s*([^\\n]+)[\\s\\S]*?CENTRAL INDEX KEY:\\s*(\\d+)`).exec(t);
    return m ? { name: m[1].trim(), cik: m[2].replace(/^0+/, "") } : null;
  };
  return {
    form: /CONFORMED SUBMISSION TYPE:\s*([^\n]+)/.exec(t)?.[1]?.trim() ?? "",
    items: [...t.matchAll(/ITEM INFORMATION:\s*([^\n]+)/g)].map((m) => m[1].trim()),
    subject: block("SUBJECT COMPANY"), filedBy: block("FILED BY"), filer: block("\\nFILER"),
  };
}

export function seriousItems(items: string[]): typeof SERIOUS_ITEMS {
  return SERIOUS_ITEMS.filter((s) => items.some((i) => s.re.test(i)));
}

// ------------------------------------------------------------------- io

export async function fetchSec(url: string, userAgent: string, fetchImpl?: typeof fetch): Promise<string> {
  return getText(url, { headers: { "user-agent": userAgent, "accept-encoding": "gzip, deflate" }, minIntervalMs: SEC_INTERVAL_MS, cacheMs: 60 * 60000, fetchImpl, retries: 1 });
}
