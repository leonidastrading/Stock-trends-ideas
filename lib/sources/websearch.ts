/**
 * The investigator's web access: a search (Brave Search API, BRAVE_SEARCH_API_KEY) and a reader that opens a page or a
 * document and returns its text: web pages, PDFs (text layer), and, for scanned PDFs and images, the bytes so the
 * model can read them. Public addresses only; nothing is sent but the query and the address.
 */
import { decodeEntities } from "../entities";
import { cleanSiteUrl, htmlText } from "./site";
import { edinetPdfUrl } from "./asia-filings";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)" };
export interface SearchHit { title: string; url: string; snippet: string; age: string }

export const hasWebSearch = (env: NodeJS.ProcessEnv) => !!env.BRAVE_SEARCH_API_KEY?.trim();

const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&[#a-z0-9]+;/gi, (e) => decodeEntities(e)).replace(/\s+/g, " ").trim();

/** Pure: Brave's web results. */
export function braveHits(j: { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string; extra_snippets?: string[] }> } }): SearchHit[] {
  return (j.web?.results ?? []).filter((r) => r.url).map((r) => ({ title: strip(r.title ?? ""), url: r.url!, snippet: strip([r.description ?? "", ...(r.extra_snippets ?? []).slice(0, 1)].join(" ")).slice(0, 500), age: r.age ?? r.page_age?.slice(0, 10) ?? "" }));
}

export async function webSearch(query: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch, count = 6): Promise<SearchHit[]> {
  const key = env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query.slice(0, 380), count: String(count), extra_snippets: "true" })}`, { headers: { accept: "application/json", "x-subscription-token": key }, signal: ctl.signal });
    if (res.status === 429) throw new Error("Brave Search: rate limit or monthly quota reached");
    if (!res.ok) throw new Error(`Brave Search ${res.status}`);
    return braveHits(await res.json());
  } finally {
    clearTimeout(t);
  }
}

export type Opened = { url: string; kind: "html" | "pdf" | "text"; text: string } | { url: string; kind: "scan"; mediaType: string; data: string } | { url: string; kind: "error"; error: string };

const MAX_BYTES = 12 * 1024 * 1024;
const IMAGE = /^image\/(jpeg|png|gif|webp)$/;

/** Pure: the readable text of an HTML page (the article or main element when there is one). */
export function pageText(html: string): string {
  const body = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  return htmlText(body);
}

/** Open a public page or document. Text is cut to `max` characters; a scanned PDF or an image comes back as bytes. */
export async function openDocument(raw: string, fetchImpl: typeof fetch = fetch, max = 8000, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): Promise<Opened> {
  const url = cleanSiteUrl(raw);
  if (!url) return { url: raw, kind: "error", error: "not a public web address" };
  // An EDINET filing is read as its PDF through the API (the key is added here and never leaves this function).
  const target = edinetPdfUrl(url, env) ?? url;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetchImpl(target, { headers: { ...UA, accept: "text/html,application/pdf,image/*,text/plain;q=0.8,*/*;q=0.5" }, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) return { url, kind: "error", error: `${new URL(url).host} answered ${res.status}` };
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { url, kind: "error", error: "too large to read" };
    const isPdf = type === "application/pdf" || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
    if (isPdf) {
      let text = "";
      try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        text = (await extractText(await getDocumentProxy(bytes.slice()), { mergePages: true })).text as string;
      } catch { /* unreadable text layer: treat as a scan */ }
      if (text.replace(/\s/g, "").length >= 50) return { url, kind: "pdf", text: text.replace(/\s+/g, " ").trim().slice(0, max) };
      if (bytes.length > 8 * 1024 * 1024) return { url, kind: "error", error: "scanned PDF too large to read" };
      return { url, kind: "scan", mediaType: "application/pdf", data: Buffer.from(bytes).toString("base64") };
    }
    if (IMAGE.test(type)) {
      if (bytes.length > 4.5 * 1024 * 1024) return { url, kind: "error", error: "image too large to read" };
      return { url, kind: "scan", mediaType: type, data: Buffer.from(bytes).toString("base64") };
    }
    const body = new TextDecoder().decode(bytes);
    if (/html|xml/.test(type) || /^\s*</.test(body)) return { url, kind: "html", text: pageText(body).slice(0, max) };
    if (/^text\/|json/.test(type) || !type) return { url, kind: "text", text: body.replace(/\s+/g, " ").slice(0, max) };
    return { url, kind: "error", error: `cannot read ${type}` };
  } catch (e) {
    return { url, kind: "error", error: (e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e)).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}
