/**
 * Japan and Korea exchange filings for investigations (both free official APIs, keys in the environment only):
 * - EDINET (Japan FSA), EDINET_API_KEY: the API lists filings by day only, so a lookup reads the last 30 days' lists
 *   (each past day cached) and keeps a company's (by its 4-digit securities code or its name).
 * - Open DART (Korea FSS), DART_API_KEY: company code from the corp-code list (by 6-digit stock code, Korean or
 *   English name), then its filings for 180 days.
 * Keys are never put in a stored link or an error message: links are the public viewers, and errors name only the host.
 */
import { strFromU8, unzipSync } from "fflate";
import type { Lookup, RecordRow } from "./world-records";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)" };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e)).slice(0, 160);

/** A GET whose errors never include the address (it carries the key). */
async function get(url: string, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: UA, signal: ctl.signal });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res;
  } catch (e) {
    throw new Error(e instanceof Error && e.message.includes("answered") ? e.message : `${new URL(url).host}: ${errText(e)}`);
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- EDINET (Japan)

export interface EdinetDoc { docID: string; edinetCode?: string | null; secCode?: string | null; filerName?: string | null; docDescription?: string | null; submitDateTime?: string | null; docTypeCode?: string | null }
const dayCache = new Map<string, { at: number; docs: EdinetDoc[] }>();

/** Pure: a day's EDINET list (the API answers 200 with an error body for a bad key). */
export function edinetDay(j: { results?: EdinetDoc[]; StatusCode?: number; statusCode?: number; message?: string; metadata?: { status?: string; message?: string } }): EdinetDoc[] {
  const code = j.StatusCode ?? j.statusCode ?? Number(j.metadata?.status ?? 200);
  if (code !== 200) throw new Error(`EDINET ${code}: ${(j.message ?? j.metadata?.message ?? "").slice(0, 100)}`);
  return j.results ?? [];
}

/** Pure: a company's filings among the day lists, by securities code ("7203" matches "72030") or by name. */
export function edinetMatch(docs: EdinetDoc[], who: string): RecordRow[] {
  const code = who.trim().match(/^\d{4}[0-9A-Z]?$/) ? who.trim().slice(0, 4) : null;
  const name = who.trim().toLowerCase();
  return docs
    .filter((d) => (code ? (d.secCode ?? "").startsWith(code) : (d.filerName ?? "").toLowerCase().includes(name)) && d.docDescription)
    .map((d) => ({ date: (d.submitDateTime ?? "").slice(0, 10), title: d.docDescription ?? "", detail: `${d.filerName ?? "?"}${d.secCode ? ` (${d.secCode.slice(0, 4)})` : ""}`, url: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S1=${d.docID}` }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function edinetFilings(who: string, now: Date, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch, days = 30): Promise<Lookup> {
  const key = env.EDINET_API_KEY?.trim();
  const query = `EDINET "${who}"`;
  if (!key) return { query, rows: [], error: "EDINET_API_KEY not set" };
  try {
    const dates = Array.from({ length: days }, (_, i) => ymd(new Date(now.getTime() - i * 86400_000)));
    const all: EdinetDoc[] = [];
    for (let i = 0; i < dates.length; i += 6) {
      const batch = await Promise.all(dates.slice(i, i + 6).map(async (date) => {
        const hit = dayCache.get(date);
        // Past days do not change; today's list is re-read after 30 minutes.
        if (hit && (date !== dates[0] || Date.now() - hit.at < 30 * 60_000)) return hit.docs;
        const docs = edinetDay(await (await get(`https://api.edinet-fsa.go.jp/api/v2/documents.json?date=${date}&type=2&Subscription-Key=${encodeURIComponent(key)}`, fetchImpl)).json());
        dayCache.set(date, { at: Date.now(), docs });
        return docs;
      }));
      for (const b of batch) all.push(...b);
    }
    return { query, rows: edinetMatch(all, who).slice(0, 12) };
  } catch (e) {
    return { query, rows: [], error: errText(e) };
  }
}

/** The address the reader fetches for an EDINET viewer link: the filing's PDF through the API (key added here, never stored). */
export function edinetPdfUrl(url: string, env: NodeJS.ProcessEnv): string | null {
  const key = env.EDINET_API_KEY?.trim();
  const m = url.match(/^https:\/\/disclosure2\.edinet-fsa\.go\.jp\/WZEK0040\.aspx\?S1=([A-Z0-9]+)$/);
  return key && m ? `https://api.edinet-fsa.go.jp/api/v2/documents/${m[1]}?type=2&Subscription-Key=${encodeURIComponent(key)}` : null;
}

// ---------------------------------------------------------------- Open DART (Korea)

export interface DartCorp { code: string; name: string; eng: string; stock: string }
let corpCache: { at: number; corps: DartCorp[] } | null = null;

/** Pure: the listed companies in DART's CORPCODE.xml. */
export function dartCorps(xml: string): DartCorp[] {
  const out: DartCorp[] = [];
  const tag = (block: string, t: string) => block.match(new RegExp(`<${t}>\\s*([^<]*?)\\s*</${t}>`))?.[1] ?? "";
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const stock = tag(m[1], "stock_code");
    if (stock) out.push({ code: tag(m[1], "corp_code"), name: tag(m[1], "corp_name"), eng: tag(m[1], "corp_eng_name"), stock });
  }
  return out;
}

/** Pure: the company for a 6-digit stock code or a name (exact before partial; Korean or English). */
export function dartFind(corps: DartCorp[], who: string): DartCorp | null {
  const w = who.trim();
  if (/^\d{6}$/.test(w)) return corps.find((c) => c.stock === w) ?? null;
  const lw = w.toLowerCase().replace(/[.,]|\b(co|ltd|inc|corp|corporation)\b/g, "").replace(/\s+/g, " ").trim();
  const norm = (s: string) => s.toLowerCase().replace(/[.,]|\b(co|ltd|inc|corp|corporation)\b/g, "").replace(/\s+/g, " ").trim();
  return corps.find((c) => c.name === w || norm(c.eng) === lw) ?? corps.find((c) => c.name.includes(w) || (lw.length >= 4 && norm(c.eng).includes(lw))) ?? null;
}

/** Pure: a DART filing list as rows (status 013 = no filings in the range). */
export function dartRows(j: { status?: string; message?: string; list?: Array<{ rcept_dt?: string; report_nm?: string; corp_name?: string; flr_nm?: string; rcept_no?: string }> }): RecordRow[] {
  if (j.status === "013") return [];
  if (j.status && j.status !== "000") throw new Error(`DART ${j.status}: ${(j.message ?? "").slice(0, 100)}`);
  return (j.list ?? []).map((x) => {
    const d = x.rcept_dt ?? "";
    return { date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d, title: (x.report_nm ?? "").replace(/\s+/g, " ").trim(), detail: `${x.corp_name ?? ""}${x.flr_nm && x.flr_nm !== x.corp_name ? ` · filed by ${x.flr_nm}` : ""}`, url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no ?? ""}` };
  });
}

/**
 * DART's company list: a large zip that is slow to download from Vercel, so it is kept in the database for a week
 * (only the listed companies, a few hundred KB) and downloaded again only when older.
 */
async function loadCorps(key: string, fetchImpl: typeof fetch): Promise<{ at: number; corps: DartCorp[] }> {
  const db = await import("../db").catch(() => null);
  const saved = db ? ((await db.query(`SELECT data, updated_at FROM dashboard_cache WHERE key = 'dart:corps'`).catch(() => []))[0] as { data: DartCorp[]; updated_at: string } | undefined) : undefined;
  if (saved && Array.isArray(saved.data) && saved.data.length > 1000 && Date.now() - Date.parse(saved.updated_at) < 7 * 86400_000) return { at: Date.now(), corps: saved.data };
  try {
    const bytes = new Uint8Array(await (await get(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`, fetchImpl, 120_000)).arrayBuffer());
    // A bad key comes back as a small JSON or XML error, not a zip.
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`DART: ${strFromU8(bytes.slice(0, 200)).replace(/\s+/g, " ").slice(0, 120)}`);
    const corps = dartCorps(Object.values(unzipSync(bytes)).map((b) => strFromU8(b)).join(""));
    if (db && corps.length > 1000) await db.query(`INSERT INTO dashboard_cache (key, data, updated_at) VALUES ('dart:corps', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(corps)]).catch(() => undefined);
    return { at: Date.now(), corps };
  } catch (e) {
    // An older saved list is better than none while DART is slow.
    if (saved && Array.isArray(saved.data) && saved.data.length) return { at: Date.now(), corps: saved.data };
    throw e;
  }
}

export async function dartFilings(who: string, now: Date, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<Lookup> {
  const key = env.DART_API_KEY?.trim();
  const query = `DART "${who}"`;
  if (!key) return { query, rows: [], error: "DART_API_KEY not set" };
  try {
    if (!corpCache || Date.now() - corpCache.at > 24 * 3600_000) corpCache = await loadCorps(key, fetchImpl);
    const corp = dartFind(corpCache.corps, who);
    if (!corp) return { query, rows: [], error: "no listed Korean company by that name or code" };
    const d8 = (d: Date) => ymd(d).replace(/-/g, "");
    const j = await (await get(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${encodeURIComponent(key)}&corp_code=${corp.code}&bgn_de=${d8(new Date(now.getTime() - 180 * 86400_000))}&end_de=${d8(now)}&page_count=15`, fetchImpl)).json();
    return { query: `${query} → ${corp.name} (${corp.stock})`, rows: dartRows(j) };
  } catch (e) {
    return { query, rows: [], error: errText(e) };
  }
}
