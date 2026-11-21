/**
 * More public records for investigations, each a lookup that returns rows with a link and never throws:
 * - Export controls: Bureau of Industry and Security documents in the Federal Register (Entity List additions,
 *   export rules), by company name, plus the newest rules.
 * - Court dockets: CourtListener's RECAP archive of federal dockets (COURTLISTENER_TOKEN, free).
 * - Hong Kong exchange filings: HKEXnews title search (company name → stock → its announcements).
 * - Mainland China exchange filings: cninfo (the official disclosure site for Shanghai and Shenzhen).
 * - SEC full-text search across all filers: only through the relay (efts.sec.gov refuses cloud addresses).
 * All reachable from Vercel (checked Nov 2026), except SEC full text, which needs the relay.
 */
import { getText } from "../http";
import { relayRoute } from "./edgar";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)" };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number) => new Date(now.getTime() - n * 86400_000);
export interface RecordRow { date: string; title: string; detail: string; url: string }
export interface Lookup { query: string; rows: RecordRow[]; error?: string }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
async function guarded(query: string, run: () => Promise<RecordRow[]>): Promise<Lookup> {
  try { return { query, rows: await run() }; } catch (e) { return { query, rows: [], error: errText(e) }; }
}

// ---------------------------------------------------------------- export controls (Federal Register, BIS)

interface FrDoc { title: string; publication_date: string; html_url: string; abstract?: string | null; type?: string }
/** Pure: Federal Register documents as rows. */
export const frRows = (j: { results?: FrDoc[] }): RecordRow[] => (j.results ?? []).map((d) => ({ date: d.publication_date, title: d.title, detail: [d.type, (d.abstract ?? "").replace(/\s+/g, " ").slice(0, 400)].filter(Boolean).join(": "), url: d.html_url }));

export async function exportNotices(term: string | null, now: Date, fetchImpl?: typeof fetch): Promise<Lookup> {
  return guarded(term ? `"${term}"` : "newest export rules", async () => {
    const p = new URLSearchParams({ "conditions[agencies][]": "industry-and-security-bureau", order: "newest", per_page: term ? "8" : "6", "conditions[publication_date][gte]": ymd(daysAgo(now, term ? 3 * 365 : 60)) });
    if (term) p.set("conditions[term]", `"${term}"`);
    for (const f of ["title", "publication_date", "html_url", "abstract", "type"]) p.append("fields[]", f);
    return frRows(JSON.parse(await getText(`https://www.federalregister.gov/api/v1/documents.json?${p}`, { headers: UA, fetchImpl, cacheMs: 6 * 3600_000, timeoutMs: 15_000, retries: 1 })));
  });
}

// ---------------------------------------------------------------- court dockets (CourtListener)

/** Pure: CourtListener RECAP search results as rows. */
export function docketRows(j: { results?: Array<Record<string, unknown>> }): RecordRow[] {
  return (j.results ?? []).map((r) => ({
    date: String(r.dateFiled ?? r.date_filed ?? "").slice(0, 10),
    title: String(r.caseName ?? r.case_name ?? "?"),
    detail: [r.court ?? r.court_citation_string, r.docketNumber ? `No. ${r.docketNumber}` : "", r.suitNature ? `nature: ${r.suitNature}` : "", r.cause ? `cause: ${r.cause}` : "", r.dateTerminated ? `closed ${String(r.dateTerminated).slice(0, 10)}` : "open"].filter(Boolean).join(" · "),
    url: `https://www.courtlistener.com${String(r.docket_absolute_url ?? r.absolute_url ?? "/")}`,
  }));
}

export async function courtDockets(party: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Lookup> {
  const token = env.COURTLISTENER_TOKEN?.trim();
  if (!token) return { query: `"${party}"`, rows: [], error: "COURTLISTENER_TOKEN not set" };
  return guarded(`"${party}"`, async () => {
    const p = new URLSearchParams({ q: `"${party}"`, type: "r", order_by: "dateFiled desc" });
    const j = JSON.parse(await getText(`https://www.courtlistener.com/api/rest/v4/search/?${p}`, { headers: { ...UA, authorization: `Token ${token}` }, fetchImpl, cacheMs: 6 * 3600_000, timeoutMs: 20_000, retries: 1 }));
    return docketRows(j).slice(0, 8);
  });
}

// ---------------------------------------------------------------- Hong Kong (HKEXnews)

/** Pure: the HKEX stock for a name: the main listing (not a note or a derivative, e.g. "TENCENT N2801"). */
export function hkStock(body: string): { stockId: number; code: string; name: string } | null {
  const json = body.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, "");
  const list = (JSON.parse(json) as { stockInfo?: Array<{ stockId: number; code: string; name: string }> }).stockInfo ?? [];
  return list.find((s) => !/\bN\d{4}\b|-R$/.test(s.name) && /^0\d{4}$/.test(s.code)) ?? list[0] ?? null;
}

/** Pure: HKEXnews title-search rows ("DD/MM/YYYY HH:mm" dates). */
export function hkRows(body: string): RecordRow[] {
  const raw = JSON.parse(body) as { result?: string };
  const list = raw.result ? (JSON.parse(raw.result) as Array<Record<string, string>>) : [];
  const strip = (s: string) => (s ?? "").replace(/<br\/?>/g, " ").replace(/\s+/g, " ").trim();
  return list.map((r) => {
    const [d, m, y] = (r.DATE_TIME ?? "").split(" ")[0].split("/");
    return { date: y ? `${y}-${m}-${d}` : "", title: strip(r.TITLE), detail: `${strip(r.STOCK_CODE)} ${strip(r.STOCK_NAME)} · ${strip(r.LONG_TEXT)}`, url: `https://www1.hkexnews.hk${r.FILE_LINK ?? ""}` };
  });
}

export async function hkFilings(name: string, now: Date, fetchImpl?: typeof fetch): Promise<Lookup> {
  return guarded(`HKEX "${name}"`, async () => {
    const pre = await getText(`https://www1.hkexnews.hk/search/prefix.do?callback=callback&lang=EN&type=A&market=SEHK&name=${encodeURIComponent(name)}`, { headers: UA, fetchImpl, cacheMs: 24 * 3600_000, timeoutMs: 15_000, retries: 1 });
    const stock = hkStock(pre);
    if (!stock) return [];
    const ds = (d: Date) => ymd(d).replace(/-/g, "");
    const p = new URLSearchParams({ sortDir: "0", sortByOptions: "DateTime", category: "0", market: "SEHK", stockId: String(stock.stockId), documentType: "-1", fromDate: ds(daysAgo(now, 180)), toDate: ds(now), title: "", searchType: "0", t1code: "-2", t2Gcode: "-2", t2code: "-2", rowRange: "12", lang: "EN" });
    return hkRows(await getText(`https://www1.hkexnews.hk/search/titleSearchServlet.do?${p}`, { headers: UA, fetchImpl, cacheMs: 3 * 3600_000, timeoutMs: 15_000, retries: 1 }));
  });
}

// ---------------------------------------------------------------- mainland China (cninfo)

/** Pure: cninfo announcements as rows (titles are in Chinese; the PDFs are on static.cninfo.com.cn). */
export function cnRows(j: { announcements?: Array<Record<string, unknown>> | null }): RecordRow[] {
  return (j.announcements ?? []).map((a) => ({
    date: a.announcementTime ? ymd(new Date(Number(a.announcementTime))) : "",
    title: String(a.announcementTitle ?? "").replace(/<\/?em>/g, ""),
    detail: `${a.secCode ?? ""} ${a.secName ?? ""}`.trim(),
    url: a.adjunctUrl ? `http://static.cninfo.com.cn/${a.adjunctUrl}` : "http://www.cninfo.com.cn",
  }));
}

async function postForm(url: string, form: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { ...UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json" }, body: new URLSearchParams(form).toString(), signal: ctl.signal });
    if (!res.ok) throw new Error(`cninfo ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** A company's announcements (by its name, pinyin or code), or a keyword across all of them (e.g. 出口管制, export controls). */
export async function cnFilings(term: string, now: Date, fetchImpl?: typeof fetch): Promise<Lookup> {
  return guarded(`cninfo "${term}"`, async () => {
    const se = `${ymd(daysAgo(now, 180))}~${ymd(now)}`;
    const hits = (await postForm("http://www.cninfo.com.cn/new/information/topSearch/query", { keyWord: term, maxNum: "5" }, fetchImpl)) as Array<{ code: string; orgId: string; category: string; zwjc?: string }>;
    const stock = Array.isArray(hits) ? hits.find((h) => /A股|B股|H股/.test(h.category ?? "")) ?? hits[0] : undefined;
    const form: Record<string, string> = stock
      ? { pageNum: "1", pageSize: "12", column: /^6/.test(stock.code) ? "sse" : "szse", tabName: "fulltext", stock: `${stock.code},${stock.orgId}`, seDate: se }
      : { pageNum: "1", pageSize: "12", column: "szse", tabName: "fulltext", searchkey: term, seDate: se };
    return cnRows((await postForm("http://www.cninfo.com.cn/new/hisAnnouncement/query", form, fetchImpl)) as { announcements?: Array<Record<string, unknown>> });
  });
}

// ---------------------------------------------------------------- SEC full-text search (through the relay)

interface FtsHit { _id: string; _source: { display_names?: string[]; form?: string; file_type?: string; form_type?: string; file_date?: string; ciks?: string[]; adsh?: string } }
/** Pure: EDGAR full-text hits as rows linking to the document itself. */
export function ftsRows(j: { hits?: { hits?: FtsHit[] } }): RecordRow[] {
  return (j.hits?.hits ?? []).map((h) => {
    const [adsh, file] = h._id.split(":");
    const cik = (h._source.ciks?.[0] ?? "").replace(/^0+/, "");
    return {
      date: h._source.file_date ?? "", title: `${h._source.form ?? h._source.form_type ?? h._source.file_type ?? "filing"}: ${h._source.display_names?.[0] ?? "?"}`, detail: file ?? "",
      url: cik && adsh && file ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${file}` : "https://efts.sec.gov/LATEST/search-index",
    };
  });
}

export async function secFullText(phrase: string, now: Date, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Lookup> {
  const r = relayRoute(env);
  if (!r) return { query: `"${phrase}"`, rows: [], error: "the EDGAR relay is not set up (EDGAR_PROXY_URL)" };
  return guarded(`"${phrase}"`, async () => {
    const target = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${phrase}"`)}&dateRange=custom&startdt=${ymd(daysAgo(now, 2 * 365))}&enddt=${ymd(now)}`;
    return ftsRows(JSON.parse(await getText(r.url(target), { headers: { ...UA, ...r.headers }, fetchImpl, cacheMs: 3 * 3600_000, timeoutMs: 20_000, retries: 1 }))).slice(0, 10);
  });
}
