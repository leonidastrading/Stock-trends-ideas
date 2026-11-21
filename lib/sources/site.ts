/**
 * Read a website Vadim asked the scout to follow: its RSS/Atom feed if it has one
 * (advertised in the page, or at a usual path), otherwise the article links on the page.
 * Public pages only, no logins, no bot-challenge workarounds.
 */
import { getText } from "../http";

export interface Article { url: string; title: string; published: string | null; summary: string }
export interface SiteRead { feedUrl: string | null; via: "feed" | "page"; articles: Article[] }

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8" };
const FEED_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];

/** Pure: what was typed, as a public http(s) URL; null if it is not one (local and private addresses refused). */
export function cleanSiteUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port && !["80", "443"].includes(u.port)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost" || /^\[|^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  u.hash = "";
  return u.toString();
}

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/** Pure: HTML to plain text (scripts, styles and tags out, whitespace squeezed). */
export function htmlText(html: string): string {
  return decode(html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "";
const isoOrNull = (s: string) => {
  const t = Date.parse(decode(s).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export const looksLikeFeed = (body: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(body);

/** Pure: the items of an RSS or Atom feed, newest first. */
export function parseFeed(xml: string, base: string): Article[] {
  const out: Article[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const it = m[0];
    const title = htmlText(decode(tag(it, "title"))).slice(0, 300);
    let link = decode(tag(it, "link")).trim();
    if (!link) link = it.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i)?.[1] ?? it.match(/<link\b[^>]*href=["']([^"']+)/i)?.[1] ?? "";
    if (!link) link = decode(tag(it, "guid")).trim();
    const url = absolute(decode(link), base);
    if (!title || !url) continue;
    const summary = htmlText(decode(tag(it, "description") || tag(it, "summary") || tag(it, "content:encoded") || tag(it, "content"))).slice(0, 1200);
    out.push({ url, title, published: isoOrNull(tag(it, "pubDate") || tag(it, "published") || tag(it, "updated") || tag(it, "dc:date")), summary });
  }
  return out.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Pure: the feed a page advertises in its <head>, if any. */
export function feedLink(html: string, base: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (/rel=["']?alternate/i.test(t) && /type=["']?application\/(rss|atom)\+xml/i.test(t)) {
      const href = t.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) return absolute(decode(href), base);
    }
  }
  return null;
}

/** Pure: links on the page that look like articles: same site, a headline-length text, a path deeper than a section page. */
export function articleLinks(html: string, base: string, max = 40): Article[] {
  const host = new URL(base).hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(decode(m[1]), base);
    if (!url || seen.has(url)) continue;
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== host) continue;
    const path = u.pathname.replace(/\/$/, "");
    const slugLike = /[-_][a-z0-9]+[-_]/i.test(path) || /\/\d{4}\/\d{1,2}\//.test(path) || path.split("/").filter(Boolean).length >= 3;
    const title = htmlText(m[2]).replace(/\s+/g, " ").trim();
    if (!slugLike || title.length < 25 || title.length > 300) continue;
    if (/^(read more|continue reading|subscribe|sign up|log in)/i.test(title) || /\/(tag|tags|category|author|page|login|signup|subscribe|about|contact|privacy|terms)(\/|$)/i.test(path)) continue;
    if (/\b(privacy|cookie|terms of (use|service)|disclosure|comment (policy|guidelines)|offensive comments|advertise|careers|newsletter sign|support us|donate)\b/i.test(title) || /(privacy|cookie|terms|disclosure|policy|guidelines|faq|help|advertis|careers|donate|store|shop)/i.test(path.split("/").filter(Boolean)[0] ?? "")) continue;
    seen.add(url);
    out.push({ url, title, published: null, summary: "" });
    if (out.length >= max) break;
  }
  return out;
}

const MONTH_DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;

/**
 * Pure: reports a page links to as documents (short-seller and research sites list PDFs, often on another host such
 * as S3, behind a "Download PDF" link). The title is the heading(s) just above the link, the date the last date
 * written before it; newest first.
 */
export function reportLinks(html: string, base: string, max = 40): Article[] {
  const out: Article[] = [];
  const seen = new Set<string>();
  // Look back for a report's heading and date only as far as the previous report link (never borrow another's).
  let lastEnd = 0;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(decode(m[1]), base);
    if (!url || seen.has(url)) continue;
    const text = htmlText(m[2]).replace(/\s+/g, " ").trim();
    const isDoc = /\.pdf(\?|$)/i.test(new URL(url).pathname + new URL(url).search) || /^(download|read|view)\b.{0,20}\b(pdf|report)\b|^(full|the) report\b/i.test(text);
    if (!isDoc) continue;
    const before = html.slice(Math.max(lastEnd, m.index! - 3000), m.index!);
    lastEnd = m.index! + m[0].length;
    const heads = [...before.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((h) => htmlText(h[1]).replace(/\s+/g, " ").trim()).filter((h) => h.length >= 3);
    const file = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "").replace(/[+_]/g, " ");
    const title = (heads.length ? heads.slice(-2).join(" — ") : text.length >= 15 && !/^(download|read|view)\b/i.test(text) ? text : `${file} (report, PDF)`).slice(0, 300);
    const dates = [...htmlText(before.slice(-1500)).matchAll(MONTH_DATE)];
    const d = dates.at(-1);
    const published = d ? isoOrNull(`${d[1]} ${d[2]}, ${d[3]}`) : null;
    seen.add(url);
    out.push({ url, title, published, summary: heads.length ? `${heads.slice(-2).join(". ")} (report, PDF)` : "" });
    if (out.length >= max) break;
  }
  return out.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
}

/** Fetch a site's newest articles: feed first, then the page's links. Throws when nothing readable comes back. */
export async function readSite(url: string, feedUrl: string | null = null, fetchImpl?: typeof fetch): Promise<SiteRead> {
  const get = (u: string) => getText(u, { headers: UA, cacheMs: 0, retries: 1, timeoutMs: 20_000, fetchImpl });
  if (feedUrl) {
    const items = parseFeed(await get(feedUrl), feedUrl);
    if (items.length) return { feedUrl, via: "feed", articles: items };
  }
  const body = await get(url);
  if (looksLikeFeed(body)) return { feedUrl: url, via: "feed", articles: parseFeed(body, url) };
  const candidates = [feedLink(body, url), ...FEED_PATHS.map((p) => absolute(p, url))].filter((x): x is string => !!x);
  for (const f of [...new Set(candidates)].slice(0, 4)) {
    try {
      const xml = await get(f);
      if (!looksLikeFeed(xml)) continue;
      const items = parseFeed(xml, f);
      if (items.length) return { feedUrl: f, via: "feed", articles: items };
    } catch {
      /* no feed there */
    }
  }
  // Reports linked as documents first (newest first), then article links on the site itself.
  const reports = reportLinks(body, url);
  const have = new Set(reports.map((r) => r.url));
  const links = [...reports, ...articleLinks(body, url).filter((a) => !have.has(a.url))].slice(0, 40);
  if (!links.length) throw new Error("no feed, no article links and no report links (PDFs) found on that page");
  return { feedUrl: null, via: "page", articles: links };
}

/** An article's text for the reader (best effort; empty on failure). */
export async function articleText(url: string, max = 3000, fetchImpl?: typeof fetch): Promise<string> {
  // A report (PDF): its text layer, read the same way the investigator reads documents.
  if (/\.pdf(\?|$)/i.test(url)) {
    const { openDocument } = await import("./websearch");
    const o = await openDocument(url, fetchImpl, max).catch(() => null);
    return o && (o.kind === "pdf" || o.kind === "text" || o.kind === "html") ? o.text : "";
  }
  try {
    const html = await getText(url, { headers: UA, cacheMs: 0, retries: 0, timeoutMs: 12_000, fetchImpl });
    const body = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
    return htmlText(body).slice(0, max);
  } catch {
    return "";
  }
}
