/**
 * The Internet Archive's Wayback Machine (free, no key): the saved copy of a page nearest a date, every capture of a
 * page, the page's text as it was, and saving a page now (so evidence the scout cites stays verifiable if the page
 * changes or disappears). Polite: a pause between calls, short timeouts.
 */
import type { Lookup, RecordRow } from "./world-records";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)" };
let last = 0;
async function pace(ms = 1500) { if (process.env.VITEST) return; const wait = last + ms - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); }

/** Pure: a Wayback timestamp (YYYYMMDDhhmmss) as an ISO date-time. */
export const tsIso = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10) || "00"}:${ts.slice(10, 12) || "00"}:${ts.slice(12, 14) || "00"}Z`;
/** Pure: an ISO date as a Wayback timestamp. */
export const isoTs = (d: string) => d.replace(/[^0-9]/g, "").slice(0, 14).padEnd(8, "0");

/** The saved copy nearest a date (YYYY-MM-DD), or null. */
export async function closest(url: string, date: string, fetchImpl: typeof fetch = fetch): Promise<{ ts: string; url: string } | null> {
  await pace();
  const res = await fetchImpl(`https://archive.org/wayback/available?${new URLSearchParams({ url, timestamp: isoTs(date) })}`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Wayback ${res.status}`);
  const j = (await res.json()) as { archived_snapshots?: { closest?: { available?: boolean; timestamp?: string; url?: string } } };
  const c = j.archived_snapshots?.closest;
  return c?.available && c.timestamp && c.url ? { ts: c.timestamp, url: c.url } : null;
}

/** Pure: the CDX reply (JSON rows with a header) as captures. */
export function parseCdx(rows: unknown): Array<{ ts: string; url: string; status: string; digest: string }> {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const head = rows[0] as string[];
  const at = (r: string[], k: string) => r[head.indexOf(k)] ?? "";
  return (rows.slice(1) as string[][]).map((r) => ({ ts: at(r, "timestamp"), url: at(r, "original"), status: at(r, "statuscode"), digest: at(r, "digest") })).filter((c) => /^\d{14}$/.test(c.ts));
}

/** Every capture of a page in a date range, only when its content changed (successful pages only). */
export async function captures(url: string, from: string, to: string, fetchImpl: typeof fetch = fetch, limit = 50) {
  await pace();
  const q = new URLSearchParams({ url, output: "json", from: isoTs(from).slice(0, 8), to: isoTs(to).slice(0, 8), collapse: "digest", limit: String(limit) });
  q.append("filter", "statuscode:200");
  const res = await fetchImpl(`https://web.archive.org/cdx/search/cdx?${q}`, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Wayback CDX ${res.status}`);
  return parseCdx(await res.json().catch(() => []));
}

/** The page's raw HTML as captured at `ts` (the id_ form: the original page, without the archive's toolbar). */
export async function snapshotHtml(url: string, ts: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  await pace();
  const res = await fetchImpl(`https://web.archive.org/web/${ts}id_/${url}`, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`Wayback snapshot ${res.status}`);
  return res.text();
}

/** Save a page now; returns the archived copy's address, or null. Anonymous saving is rate-limited: use sparingly. */
export async function savePage(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  await pace(4000);
  const res = await fetchImpl(`https://web.archive.org/save/${url}`, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!res) return null;
  const loc = res.headers.get("content-location") ?? res.headers.get("location");
  if (loc && /\/web\/\d{14}/.test(loc)) return loc.startsWith("http") ? loc : `https://web.archive.org${loc}`;
  if (res.ok) { const c = await closest(url, new Date().toISOString().slice(0, 10), fetchImpl).catch(() => null); return c?.url ?? null; }
  return null;
}

/** Pure: "https://site/page @ 2025-03-01" (or a bare address) as a page and a date. */
export function parsePageRef(s: string, today: string): { url: string; date: string } | null {
  const m = s.trim().match(/^(https?:\/\/\S+?)(?:\s*@\s*(\d{4}-\d{2}-\d{2}))?$/);
  return m ? { url: m[1], date: m[2] ?? today } : null;
}

/** For investigations: what a page said around a date (the nearest saved copy), as record rows. */
export async function pageAsOf(ref: string, today: string, textOf: (html: string) => string, fetchImpl: typeof fetch = fetch): Promise<Lookup> {
  const r = parsePageRef(ref, today);
  if (!r) return { query: ref, rows: [], error: "not a page address" };
  try {
    const c = await closest(r.url, r.date, fetchImpl);
    if (!c) return { query: `${r.url} around ${r.date}`, rows: [] };
    const text = textOf(await snapshotHtml(r.url, c.ts, fetchImpl)).replace(/\s+/g, " ").slice(0, 3000);
    const row: RecordRow = { date: tsIso(c.ts).slice(0, 10), title: `${r.url} as saved ${tsIso(c.ts).slice(0, 10)}`, detail: text, url: c.url };
    return { query: `${r.url} around ${r.date}`, rows: [row] };
  } catch (e) {
    return { query: `${r.url} around ${r.date}`, rows: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}
