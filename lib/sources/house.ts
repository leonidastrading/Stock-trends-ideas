/**
 * House of Representatives periodic transaction reports (STOCK Act), from the
 * Clerk's public disclosure site (checked from Vercel's network on 2026-11-14):
 * - disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip: an XML
 *   index of every filing that year (FilingType "P" = periodic transaction report).
 * - .../ptr-pdfs/{year}/{DocID}.pdf: the report. Electronic filings carry a text
 *   layer; paper filings (scanned images) do not and are recorded as unreadable.
 * Only rows with an exchange ticker and asset type ST (stock) or OP (option) are
 * kept; bonds, T-bills, funds and private holdings have no ticker and are skipped.
 */
import { inflateRawSync } from "node:zlib";

const BASE = "https://disclosures-clerk.house.gov/public_disc";
const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "*/*" };

// ------------------------------------------------------------------ zip

/** Pure: the files in a zip archive (stored or deflated entries), by name. */
export function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------- index

export interface HouseFiling { docId: string; member: string; stateDst: string; filed: string; year: number }

const tag = (block: string, t: string) => (block.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1]?.trim() ?? "";
const usDate = (d: string) => { const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };

/** Pure: periodic transaction reports from the yearly index XML. */
export function parseHouseIndex(xml: string): HouseFiling[] {
  const out: HouseFiling[] = [];
  for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    const b = m[1];
    if (tag(b, "FilingType") !== "P") continue;
    const filed = usDate(tag(b, "FilingDate"));
    const docId = tag(b, "DocID");
    if (!filed || !/^\d+$/.test(docId)) continue;
    const member = [tag(b, "First"), tag(b, "Last"), tag(b, "Suffix")].filter(Boolean).join(" ");
    out.push({ docId, member, stateDst: tag(b, "StateDst"), filed, year: Number(tag(b, "Year")) || Number(filed.slice(0, 4)) });
  }
  return out;
}

export async function houseIndex(year: number, fetchImpl: typeof fetch = fetch): Promise<HouseFiling[]> {
  const res = await fetchImpl(`${BASE}/financial-pdfs/${year}FD.zip`, { headers: UA });
  if (!res.ok) throw new Error(`House Clerk index ${res.status}`);
  const files = unzip(new Uint8Array(await res.arrayBuffer()));
  const xml = [...files.entries()].find(([n]) => /\.xml$/i.test(n))?.[1];
  if (!xml) throw new Error("House Clerk index: no XML in the zip");
  return parseHouseIndex(new TextDecoder().decode(xml).replace(/^﻿/, ""));
}

export async function housePtrPdf(f: HouseFiling, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchImpl(`${BASE}/ptr-pdfs/${f.year}/${f.docId}.pdf`, { headers: UA });
  if (!res.ok) throw new Error(`House Clerk report ${f.docId}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export const housePtrUrl = (f: { docId: string; year: number }) => `${BASE}/ptr-pdfs/${f.year}/${f.docId}.pdf`;

// ---------------------------------------------------------------- trades

export type TxKind = "buy" | "sell" | "partial sale" | "exchange";
export interface PtrTrade { ord: number; owner: "self" | "spouse" | "joint" | "child"; symbol: string; assetType: "stock" | "option"; tx: TxKind; txDate: string; notified: string; amountLow: number | null; amountHigh: number | null; amount: string }

const ROW = /\(([A-Z][A-Z0-9.]{0,6})\)\s*\[(ST|OP)\]\s*(P|S \(partial\)|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+\s*-\s*\$[\d,]+|Over \$[\d,]+|\$[\d,]+)/g;
const TX: Record<string, TxKind> = { P: "buy", S: "sell", "S (partial)": "partial sale", E: "exchange" };
const OWNER = { SP: "spouse", JT: "joint", DC: "child" } as const;

export function amountRange(s: string): { low: number | null; high: number | null } {
  const n = (x: string) => Number(x.replace(/[$,\s]/g, ""));
  const over = s.match(/Over \$([\d,]+)/);
  if (over) return { low: n(over[1]) + 1, high: null };
  const r = s.match(/\$([\d,]+)\s*-\s*\$([\d,]+)/);
  if (r) return { low: n(r[1]), high: n(r[2]) };
  const one = s.match(/\$([\d,]+)/);
  return one ? { low: n(one[1]), high: n(one[1]) } : { low: null, high: null };
}

/** Pure: listed stock and option trades from a report's text layer (rows wrap across lines; whitespace is collapsed first). */
export function parsePtrText(text: string): PtrTrade[] {
  const s = text.replace(/\u0000/g, "").replace(/\s+/g, " ");
  const out: PtrTrade[] = [];
  let prevEnd = 0;
  for (const m of s.matchAll(ROW)) {
    const seg = s.slice(prevEnd, m.index);
    prevEnd = m.index + m[0].length;
    const owner = [...seg.matchAll(/(?:^|\s)(SP|JT|DC)\s/g)].at(-1)?.[1] as keyof typeof OWNER | undefined;
    const txDate = usDate(m[4]), notified = usDate(m[5]);
    if (!txDate || !notified) continue;
    const amount = m[6].replace(/\s+/g, " ").trim();
    const { low, high } = amountRange(amount);
    out.push({ ord: out.length, owner: owner ? OWNER[owner] : "self", symbol: m[1], assetType: m[2] === "OP" ? "option" : "stock", tx: TX[m[3]], txDate, notified, amountLow: low, amountHigh: high, amount });
  }
  return out;
}

/** A scanned paper filing has (almost) no text layer. */
export const isScanned = (text: string) => text.replace(/\s+/g, "").length < 200 || !/Filing ID|Transaction|Owner/i.test(text);
