/**
 * One company matcher for every page.
 *
 * Text is linked to a ticker only when it names the company, or gives the symbol with a US exchange in front of it
 * ("NYSE: X", "Nasdaq: X"). Never on a single word the company's name happens to contain, and never on bare capital
 * letters. Where this came from (November 2026): FDA petitions were linked to any stock whose name shared one word
 * with the petition, so "American College of ..." linked Sea, JD.com, Oatly, Sony, Pony AI and Arm (each an "American
 * Depositary Share") and American Airlines; UK company filings in the news feed arrived tagged with the US stock or
 * fund that has the same letters (Babcock as BAB, a US bond fund); and the AI's guesses for a ticker were kept
 * unchecked (SharkNinja under five symbols).
 *
 * - `mentionsCompany`: the company's name, without legal forms and listing words, appears in the text as a phrase.
 * - `qualifiedSymbols`: symbols the text gives with an exchange, US and foreign apart.
 * - `cleanNewsSymbols`: a news item's tags, with foreign listings taken off (they are kept with their exchange).
 * - `listingOf`: what a symbol from Stocktwits is (US stock, foreign listing, crypto, currency) and how to chart it.
 * - `unitWarrantRight`: SPAC units, warrants and rights, which are not the company's stock.
 */
const LEGAL = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "companies", "ltd", "limited", "plc", "llc", "lp", "llp", "sa", "nv", "ag", "se", "ab", "asa", "spa", "oyj", "as", "bv", "kk", "holdings", "holding", "group", "trust", "the", "and", "&", "of"]);

/** Words that are company names and ordinary prose both: alone they prove nothing. */
const GENERIC = new Set(`american america united national general first global international universal standard central western eastern northern southern pacific atlantic continental
resources energy capital financial partners industries technologies technology systems solutions services enterprises products brands sciences science networks network communications
bank bancorp savings insurance realty properties property royalty minerals mining gold silver oil gas power electric water steel paper foods food beverage health healthcare medical
pharma pharmaceuticals therapeutics biosciences biotech bio labs laboratories diagnostics devices
quest target sea arm pony block unity match snap gap square sprout root compass
summit pinnacle liberty eagle phoenix frontier spirit delta alliance allied premier prime select core vital progress progressive principal guardian sentinel pioneer discovery
vision insight focus signal genesis legacy heritage advance advanced applied modern new old big blue green red black white golden crown royal star sun moon ocean river mountain
life live home house land city park world planet earth space sky cloud wave edge path way bridge gate key lock box ring link line point mark note page book school college university
research development education entertainment media digital data software hardware machine motor motors auto car air airlines travel express logistics transport shipping
group holdings company corporation fund funds income growth value equity equities security securities investment investments management ventures acquisition`.split(/\s+/));

const norm = (s: string) => ` ${s.toLowerCase().replace(/&/g, " & ").replace(/[^a-z0-9&]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** Pure: a company name cut at its listing boilerplate ("Sea Ltd American Depositary Shares, each representing ..." → "Sea Ltd"). */
export function withoutListingWords(name: string): string {
  return name.replace(/\([^)]*\)/g, " ")
    .replace(/[\s,/-]*\b(american depositary|american depository|depositary (?:shares?|receipts?)|depository (?:shares?|receipts?)|sponsored adr|unsponsored adr|adr\b|ads\b|each representing|common stock|common shares?|ordinary shares?|class [a-z]\b|series [a-z]\b|new common|par value|\$?0?\.\d+ par|warrants?\b|units?\b|rights?\b).*$/i, "")
    .trim();
}

/** Pure: the words a company is known by, in order, without legal forms ("TransMedics Group, Inc." → ["transmedics"]). */
export function coreName(name: string): string[] {
  const t = norm(withoutListingWords(name)).trim().split(" ").filter(Boolean);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  while (t.length > 1 && t[0] === "the") t.shift();
  return t.length === 1 && LEGAL.has(t[0]) ? [] : t;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pure: does the text name this company? The first two words of its name have to appear together ("American
 * Airlines", "Quest Diagnostics"). A one-word name counts when the word is distinctive and written as a name
 * ("Pfizer", "TransMedics"); a one-word name that is also an ordinary word ("Sea", "Arm", "Target") counts only with
 * its legal form beside it ("Arm Holdings", "Sea Ltd"). Two ordinary words count when written as a name ("Quest
 * Diagnostics", not "a quest for diagnostics"), or with the third word when the name has one.
 * `loose` is for checking a ticker someone already attached to a text about one company (an AI's guess for a
 * headline): there an ordinary word written as a name is enough ("Target raises its forecast").
 */
export function mentionsCompany(text: string, name: string, opts: { loose?: boolean } = {}): boolean {
  const core = coreName(name);
  if (!core.length || !text) return false;
  const hay = norm(text);
  const full = norm(withoutListingWords(name)).trim().split(" ").filter(Boolean);
  const withForm = full.length > core.length ? full.slice(0, core.length + 1).join(" ") : null;
  if (core.length === 1) {
    const w = core[0];
    const plain = w.length >= 4 || /\d/.test(w);
    if (!plain || GENERIC.has(w)) return (!!withForm && hay.includes(` ${withForm} `)) || (!!opts.loose && w.length >= 3 && sameWordCapitalised(text, w));
    // Written as a name: capitalised (or all capitals) in the text, not a lower-case common noun.
    return sameWordCapitalised(text, w);
  }
  const two = core.slice(0, 2);
  if (!opts.loose && two.every((w) => GENERIC.has(w) || LEGAL.has(w))) {
    // Two ordinary words: three words of the name when it has them; else the two written as a name ("Quest Diagnostics").
    if (core.length >= 3) return hay.includes(` ${core.slice(0, 3).join(" ")} `);
    return new RegExp(`(?<![A-Za-z0-9])${two.map((w) => `[${esc(w[0].toUpperCase())}]${esc(w.slice(1))}`).join("[\\s-]+")}(?![A-Za-z0-9])`).test(text) || text.toUpperCase() === text && hay.includes(` ${two.join(" ")} `) || text.includes(two.join(" ").toUpperCase());
  }
  return hay.includes(` ${two.join(" ")} `);
}

/** Pure: the word appears in the text with a capital first letter, whatever the case of the rest ("OATLY", "Oatly", "TransMedics"). */
function sameWordCapitalised(text: string, w: string): boolean {
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])(${esc(w)})(?![A-Za-z0-9])`, "gi"))) if (/^[A-Z0-9]/.test(m[1])) return true;
  return false;
}

/** Words on a drug label that are not the drug. */
const DRUG_GENERIC = new Set(`injection injectable tablets tablet capsules capsule solution suspension extended release delayed oral topical nasal spray cream gel ointment patch infusion
sodium potassium calcium chloride hydrochloride acetate sulfate phosphate citrate tartrate maleate succinate mesylate besylate fumarate bromide oxide acid
human recombinant vaccine therapy treatment generic biosimilar combination adjuvant pediatric adult dose doses`.split(/\s+/));

/** Pure: the words a drug is known by (its own names, not its form or salt). */
export function drugWords(drug: string): string[] {
  return drug.split(/[\s,/()+]+/).map((w) => w.replace(/[^A-Za-z0-9-]/g, "")).filter((w) => w.length >= 5 && /^[A-Za-z][A-Za-z0-9-]+$/.test(w) && !DRUG_GENERIC.has(w.toLowerCase())).slice(0, 3);
}

/** Pure: does the text name this drug? A whole word, any case (drug names are not ordinary words). */
export const mentionsDrug = (text: string, drug: string) => drugWords(drug).some((w) => new RegExp(`(?<![A-Za-z0-9])${esc(w)}(?![A-Za-z0-9])`, "i").test(text));

const US_EX = "NASDAQ|Nasdaq|NasdaqGS|NasdaqGM|NasdaqCM|NYSE American|NYSE Arca|NYSE MKT|NYSE|AMEX|Cboe BZX|Cboe|CBOE|BATS|OTCQX|OTCQB|OTC Markets|OTC";
const FOREIGN_EX = "LSE|LON|AIM|TSXV|TSX-V|TSX|CSE|NEO|ASX|HKEX|HKG|SEHK|KRX|KOSPI|KOSDAQ|TSE|TYO|JPX|SSE|SZSE|SGX|NSE|BSE|FRA|ETR|XETRA|EPA|Euronext(?: [A-Z][a-z]+)?|AMS|BME|BIT|SIX|SWX|STO|OMX|CPH|HEL|OSE|JSE|TASE|B3|BMV|NZX|TWSE|TPE|WSE|VIE|MOEX|FWB|OTCPK";

/** Pure: symbols a text gives with an exchange in front ("(NYSE: BA)", "LSE:BAB"), US and foreign apart. */
export function qualifiedSymbols(text: string): { us: string[]; foreign: Array<{ exchange: string; symbol: string }> } {
  const us = [...text.matchAll(new RegExp(`(?<![A-Za-z])(?:${US_EX})\\s*(?:GS|GM|CM)?\\s*:\\s*\\$?([A-Z]{1,5}(?:\\.[A-Z])?)(?![A-Za-z])`, "g"))].map((m) => m[1]);
  const foreign = [...text.matchAll(new RegExp(`(?<![A-Za-z])(${FOREIGN_EX})\\s*:\\s*\\$?([A-Z0-9]{1,6}(?:\\.[A-Z]{1,2})?)(?![A-Za-z0-9])`, "g"))].map((m) => ({ exchange: m[1], symbol: m[2] }));
  return { us: [...new Set(us)], foreign };
}

/** Headlines London-listed companies file under (the regulatory news service's own titles). */
const UK_NOTICE = /\b(Holding\(s\) in Company|Director\/PDMR Shareholding|PDMR|Transaction in Own Shares|Total Voting Rights|Result of AGM|Notice of AGM|Block [Ll]isting|Form 8\.[35]|Form 8 \(|Net Asset Value|Publication of (?:a )?(?:Prospectus|Circular)|Trading Statement|Trading Update|Interim Results|Half[- ][Yy]ear (?:Report|Results)|Final Results|Preliminary Results|Annual Financial Report|Issue of Equity|Director Declaration|Directorate Change|Change of Adviser|Posting of Annual Report|Rule 2\.[4-9]|TR-1)\b/;

/** Pure: does this headline read like a listing outside the US (a PLC, a London notice, a foreign exchange and no US one)? */
export function looksForeign(text: string): boolean {
  const q = qualifiedSymbols(text);
  if (q.us.length) return false;
  return q.foreign.length > 0 || /\b(?:PLC|plc|Plc)\b/.test(text) || UK_NOTICE.test(text) || /\b(?:S\.p\.A\.|SpA|ASA|Oyj|AB \(publ\)|Berhad|Bhd|Tbk)\b/.test(text);
}

/**
 * Pure: a news item's tags, checked. A symbol the text gives with a foreign exchange is that listing, not the US
 * symbol with the same letters: it is taken off and kept as "LSE: BAB". When the item reads like a foreign listing,
 * a tag stays only if the text names the US company behind it (Aon plc stays AON; Babcock does not become the US
 * fund BAB). Ordinary US news keeps the feed's own tags.
 */
export function cleanNewsSymbols(item: { headline: string; summary?: string; symbols: string[] }, nameOf: (symbol: string) => string | null | undefined): { symbols: string[]; foreign: string[] } {
  if (!item.symbols.length) return { symbols: item.symbols, foreign: [] };
  const text = `${item.headline} ${item.summary ?? ""}`;
  const q = qualifiedSymbols(text);
  const abroad = looksForeign(text);
  if (!q.foreign.length && !abroad) return { symbols: item.symbols, foreign: [] };
  const base = (s: string) => s.replace(/\.[A-Z]{1,2}$/, "");
  const foreignBy = new Map(q.foreign.map((f) => [base(f.symbol), f.exchange]));
  const kept: string[] = [], foreign: string[] = [];
  for (const s of item.symbols) {
    if (q.us.includes(s)) { kept.push(s); continue; }
    const name = nameOf(s);
    if (name && mentionsCompany(text, name)) { kept.push(s); continue; }
    if (foreignBy.has(s)) { foreign.push(`${foreignBy.get(s)}: ${s}`); continue; }
    if (abroad) { foreign.push(s); continue; }
    kept.push(s);
  }
  return { symbols: kept, foreign };
}

/** Stocktwits' exchange suffixes and exchange names, as TradingView writes them. */
const TV_EXCHANGE: Record<string, string> = {
  TSX: "TSX", TO: "TSX", CA: "TSX", TSXV: "TSXV", V: "TSXV", CSE: "CSE", CN: "CSE", NEO: "NEO", LSE: "LSE", L: "LSE", LON: "LSE", AIM: "LSE", ASX: "ASX", AX: "ASX",
  HK: "HKEX", HKEX: "HKEX", KRX: "KRX", KS: "KRX", KOSPI: "KRX", KOSDAQ: "KRX", KQ: "KRX", T: "TSE", TSE: "TSE", TYO: "TSE", NSE: "NSE", NS: "NSE", BSE: "BSE", BO: "BSE",
  DE: "XETR", XETRA: "XETR", ETR: "XETR", F: "FWB", FRA: "FWB", PA: "EURONEXT", AS: "EURONEXT", BR: "EURONEXT", MI: "MIL", MC: "BME", SW: "SIX", ST: "OMXSTO", OL: "OSL", CO: "OMXCOP", HE: "OMXHEX", SG: "SGX", TW: "TWSE", NZ: "NZX", SA: "BMFBOVESPA", MX: "BMV",
};
const US_EXCHANGES = /^(NASDAQ|NYSE|NYSEARCA|NYSE ARCA|NYSEAMERICAN|NYSE AMERICAN|NYSEMKT|NYSE MKT|AMEX|ARCA|BATS|CBOE|OTC|OTCMKTS|OTCQX|OTCQB|PINK)$/i;

export interface Listing { kind: "us" | "foreign" | "crypto" | "currency" | "other"; symbol: string; exchange: string | null; /** TradingView's symbol for a chart, when it has one. */ tv: string | null }

/**
 * Pure: what a symbol on a Stocktwits list is. "AC.TSX" is Air Canada in Toronto (kept with its exchange, never read
 * as a US symbol AC); "BRK.B" is a US share class; "BTC.X" is crypto; "EURUSD" on the FX exchange is a currency pair.
 */
export function listingOf(symbol: string, exchange?: string | null): Listing {
  const s = symbol.toUpperCase().trim(), ex = (exchange ?? "").toUpperCase().trim();
  if (/^X(AU|AG|PT|PD)USD$/.test(s)) return { kind: "currency", symbol: s, exchange: ex || null, tv: `OANDA:${s}` };
  if (/^(FX|FOREX)$/.test(ex)) return { kind: "currency", symbol: s, exchange: ex, tv: /^[A-Z]{6}$/.test(s) ? `FX:${s}` : null };
  if (/\.X$/.test(s) || ex === "CRYPTO") return { kind: "crypto", symbol: s, exchange: ex || null, tv: /^[A-Z0-9]{2,6}\.X$/.test(s) ? `COINBASE:${s.replace(/\.X$/, "")}USD` : null };
  if (/^(INDEX|INDICES|FUTURES)$/.test(ex)) return { kind: "other", symbol: s, exchange: ex, tv: null };
  const dot = /^([A-Z0-9]{1,8})\.([A-Z]{1,6})$/.exec(s);
  if (dot) {
    // One letter after the dot is a US share class (BRK.B, BF.A) unless the exchange says otherwise.
    if (dot[2].length === 1 && !["V", "L", "T", "F"].includes(dot[2]) && (!ex || US_EXCHANGES.test(ex))) return { kind: "us", symbol: s, exchange: ex || null, tv: null };
    const tvEx = TV_EXCHANGE[dot[2]] ?? TV_EXCHANGE[ex] ?? null;
    return { kind: "foreign", symbol: s, exchange: tvEx ?? dot[2], tv: tvEx ? `${tvEx}:${dot[1]}` : null };
  }
  if (ex && !US_EXCHANGES.test(ex) && TV_EXCHANGE[ex]) return { kind: "foreign", symbol: s, exchange: TV_EXCHANGE[ex], tv: `${TV_EXCHANGE[ex]}:${s}` };
  if (/^\d+$/.test(s)) return { kind: "foreign", symbol: s, exchange: ex || null, tv: null };
  return { kind: "us", symbol: s, exchange: ex || null, tv: null };
}

/**
 * Pure: a SPAC unit, warrant or right (not the company's stock), from what the security is called, or from the
 * symbol when the name is not known (".U", ".WS", ".RT", "+", or a five-letter Nasdaq symbol ending U, W or R).
 */
export function unitWarrantRight(symbol: string, name?: string | null): "unit" | "warrant" | "right" | null {
  const n = name ?? "";
  if (/\bunits?\b/i.test(n)) return "unit";
  if (/\bwarrants?\b/i.test(n)) return "warrant";
  if (/\brights?\b/i.test(n) && !/\brights? (?:management|group)\b/i.test(n)) return "right";
  const s = symbol.toUpperCase();
  if (/[.\-/](U|UN)$/.test(s)) return "unit";
  if (/[.\-/+](W|WS|WT)$|\+$/.test(s)) return "warrant";
  if (/[.\-/](R|RT)$/.test(s)) return "right";
  if (!n && /^[A-Z]{4}U$/.test(s)) return "unit";
  if (!n && /^[A-Z]{4}W$/.test(s)) return "warrant";
  if (!n && /^[A-Z]{4}R$/.test(s)) return "right";
  return null;
}

/** Pure: a plain US-listed symbol (letters, with an optional share class), not a foreign listing, crypto or a currency. */
export const plainUsSymbol = (symbol: string, exchange?: string | null) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol.toUpperCase()) && listingOf(symbol, exchange).kind === "us";

/**
 * Units, warrants, rights and foreign listings taken out of a list of symbols (top gainers, trending). A symbol that
 * only looks like one (five letters ending U, W or R) is decided by what the security is called.
 */
export async function commonStocksOnly(symbols: string[], assetName: ((symbol: string) => Promise<string | null | undefined>) | null): Promise<string[]> {
  const out: string[] = [];
  for (const s of symbols) {
    if (!plainUsSymbol(s)) continue;
    const byShape = unitWarrantRight(s);
    if (!byShape) { out.push(s); continue; }
    const name = assetName ? await assetName(s).catch(() => undefined) : undefined;
    if (name ? !unitWarrantRight(s, name) : false) out.push(s);
  }
  return out;
}

/** Brands a few big companies are called by that their listed names do not contain. */
export const BRAND_ALIASES: Record<string, string[]> = {
  GOOGL: ["Google", "YouTube", "Waymo"], GOOG: ["Google", "YouTube", "Waymo"], META: ["Facebook", "Instagram", "WhatsApp"], XYZ: ["Square", "Cash App"],
  BRK: ["Berkshire"], "BRK.B": ["Berkshire"], "BRK.A": ["Berkshire"], TSM: ["TSMC"], BABA: ["Alibaba"], PDD: ["Temu", "Pinduoduo"], RACE: ["Ferrari"], BUD: ["Anheuser-Busch", "AB InBev"],
};

/**
 * Pure: can this company name be searched for? A name that comes down to one short acronym or one ordinary word
 * ("TMS", "Block", "Unity") measures the word, not the company: Google Trends, Wikipedia and YouTube readings for it
 * are about something else (TMS is also a medical therapy), so they are marked unusable instead of shown.
 */
export function searchableName(name: string | null | undefined): boolean {
  if (!name) return false;
  const core = coreName(name);
  if (!core.length) return false;
  if (core.length >= 2) return true;
  const w = core[0];
  const written = withoutListingWords(name).trim().split(/\s+/)[0] ?? "";
  if (w.length <= 3 || GENERIC.has(w)) return false;
  return !(written === written.toUpperCase() && w.length <= 5 && !/\d/.test(w));
}
