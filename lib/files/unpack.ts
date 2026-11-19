/**
 * Unpacking uploads in the browser before they are sent: zip archives (nested ones too), Word, PowerPoint and Excel
 * files, and plain text in any of its forms. Pure (no DOM, no network), so it runs in the browser and in tests.
 * Images and PDFs are only classified here; reading them needs the browser (canvas) or the server (the model).
 */
import { strFromU8, unzipSync } from "fflate";

export type FileKind = "zip" | "image" | "pdf" | "office" | "text" | "skip";

export const UNPACK = { maxEntries: 500, maxEntryBytes: 50_000_000, maxDepth: 2 };

const TEXT_EXT = /\.(txt|md|markdown|html?|xhtml|json|jsonl|ndjson|csv|tsv|xml|rss|atom|eml|mbox|log|rtf|srt|vtt|ya?ml)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i;
const OFFICE_EXT = /\.(docx|pptx|xlsx|odt|odp|ods)$/i;

/** Pure: what kind of file this is, by name (and MIME type when the name says nothing). */
export function kindOf(name: string, type = ""): FileKind {
  if (/\.zip$/i.test(name) || /zip/.test(type)) return "zip";
  if (/\.pdf$/i.test(name) || type === "application/pdf") return "pdf";
  if (OFFICE_EXT.test(name)) return "office";
  if (IMAGE_EXT.test(name) || type.startsWith("image/")) return "image";
  if (TEXT_EXT.test(name) || type.startsWith("text/") || /json|xml/.test(type)) return "text";
  return /\.[a-z0-9]{1,5}$/i.test(name) ? "skip" : "text"; // no extension: try it as text
}

/** Pure: true for bytes that are not text (a NUL in the first 4 KB). */
export function looksBinary(bytes: Uint8Array): boolean {
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) if (bytes[i] === 0) return true;
  return false;
}

/** Pure: UTF-8 text, without a byte-order mark. */
export const decodeText = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");

const junk = (name: string) => name.endsWith("/") || /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(name) || /(^|\/)\.[^/]+$/.test(name);

/** Pure: the files in a zip archive, nested archives opened too (two levels), system junk and huge entries skipped. */
export function unzipFiles(bytes: Uint8Array, prefix = "", depth = 0): { files: Array<{ name: string; bytes: Uint8Array }>; skipped: string[] } {
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  const skipped: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (junk(f.name)) return false;
        if (f.originalSize > UNPACK.maxEntryBytes) { skipped.push(`${prefix}${f.name} (over ${UNPACK.maxEntryBytes / 1e6} MB)`); return false; }
        return true;
      },
    });
  } catch (err) {
    return { files, skipped: [`${prefix || "archive"}: could not open the zip (${err instanceof Error ? err.message : String(err)})`] };
  }
  for (const [name, data] of Object.entries(entries)) {
    if (files.length >= UNPACK.maxEntries) { skipped.push(`${prefix}${name} and the rest (over ${UNPACK.maxEntries} files)`); break; }
    if (kindOf(name) === "zip") {
      if (depth >= UNPACK.maxDepth) { skipped.push(`${prefix}${name} (zip nested too deep)`); continue; }
      const inner = unzipFiles(data, `${prefix}${name}/`, depth + 1);
      files.push(...inner.files);
      skipped.push(...inner.skipped);
    } else files.push({ name: `${prefix}${name}`, bytes: data });
  }
  return { files, skipped };
}

const xmlDecode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

/** Pure: text from an XML part, one line per paragraph (Word, PowerPoint, OpenDocument) or cell (Excel). */
function xmlText(xml: string): string {
  return xmlDecode(
    xml
      .replace(/<(w:tab|text:tab)\b[^>]*\/>/g, "\t")
      .replace(/<(w:br|a:br|text:line-break)\b[^>]*\/>/g, "\n")
      .replace(/<\/(w:p|a:p|text:p|text:h|si|c)>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Pure: the text of a Word, PowerPoint or Excel file (or their OpenDocument cousins); "" if it has none. */
export function officeText(name: string, bytes: Uint8Array): string {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (f) => /^(word\/(document|footnotes|comments)\.xml|ppt\/(slides|notesSlides)\/\w+\.xml|xl\/sharedStrings\.xml|content\.xml)$/.test(f.name) });
  } catch {
    return "";
  }
  const order = (n: string) => Number(n.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const names = Object.keys(parts).sort((a, b) => (a.replace(/\d+\.xml$/, "") === b.replace(/\d+\.xml$/, "") ? order(a) - order(b) : a.localeCompare(b)));
  return names
    .map((n) => {
      const t = xmlText(strFromU8(parts[n]));
      const slide = n.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return t ? (slide ? `[Slide ${slide[1]}]\n${t}` : t) : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Pure: the uploaded pieces as one document, a header before each so the reader knows where a claim came from. */
export function joinParts(parts: Array<{ name: string; text: string }>, max = 400_000): string {
  const kept = parts.filter((p) => p.text.trim());
  if (kept.length === 1) return kept[0].text.trim().slice(0, max);
  return kept.map((p) => `===== ${p.name} =====\n${p.text.trim()}`).join("\n\n").slice(0, max);
}
