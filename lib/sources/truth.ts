/**
 * Donald Trump's Truth Social posts. truthsocial.com sits behind a bot challenge, so the scout reads the
 * public archive at trumpstruth.org, which republishes every post within minutes as an RSS feed of the
 * latest 100 (checked from Vercel's network on 2026-11-15).
 */
import { getText } from "../http";

export const TRUTH_FEED = "https://trumpstruth.org/feed";

export interface TruthPost { id: string; url: string; at: string; text: string; repost: boolean }

const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();

/** Pure: the posts in the feed, newest first. */
export function parseTruthFeed(xml: string): TruthPost[] {
  const out: TruthPost[] = [];
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const tag = (k: string) => item.match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`))?.[1] ?? "";
    const url = decode(tag("link"));
    const id = url.match(/statuses\/(\d+)/)?.[1] ?? decode(tag("guid"));
    const at = Date.parse(decode(tag("pubDate")));
    const text = decode(tag("description")) || decode(tag("title"));
    if (!id || Number.isNaN(at) || !text) continue;
    out.push({ id, url, at: new Date(at).toISOString(), text: text.slice(0, 4000), repost: /^RT:/.test(text) });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export async function truthPosts(fetchImpl?: typeof fetch): Promise<TruthPost[]> {
  return parseTruthFeed(await getText(TRUTH_FEED, { headers: { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "application/rss+xml, application/xml" }, fetchImpl, cacheMs: 60_000 }));
}

/** Pure: could this post touch markets? A wide net; the model decides. */
export function mightMoveMarkets(text: string): boolean {
  return /\btariff|\btrade\b|\bdeal\b|china|xi\b|japan|europe|\beu\b|mexico|canada|india|oil|opec|\bgas\b|drill|energy|\bfed\b|powell|interest rate|\brates?\b|inflation|dollar|crypto|bitcoin|stock|market|dow\b|nasdaq|s&p|\bceo\b|compan|corporat|\binc\b|merger|acquisi|antitrust|chip|semiconductor|\bai\b|pharma|drug price|medicare|steel|alumin|lumber|copper|auto|car makers|sanction|iran|russia|ukraine|israel|war\b|ceasefire|strike|executive order|\bban\b|investig|lawsuit|contract|defen[cs]e|pentagon|tiktok|apple|nvidia|tesla|boeing|intel\b|amazon|google|meta\b|microsoft|\$[A-Z]{1,5}\b|bank|tax|budget|shutdown|debt|treasur|housing|mortgage|farm|soybean|beef|egg/i.test(text);
}
