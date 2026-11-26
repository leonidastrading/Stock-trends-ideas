/**
 * Which of a website's new articles to read, and what each one led to.
 *
 * A site that posts more than six articles a day used to have its first six read, by position: on a general site
 * those were mostly politics. The six are now chosen by a cheap relevance pass in code (no AI): an article that names
 * a ticker, a company event or a market is ahead of one that does not.
 *
 * And every article of a read used to carry the same "read:" label, the ideas of the whole batch. Each article now
 * shows its own result: the ideas that came from it, or "no tradeable idea".
 */
export interface PickArticle { url: string; title: string; summary?: string; published?: string | null }

const MARKET = /\b(earnings|revenue|guidance|forecast|profit|margin|shares?|stocks?|equit(?:y|ies)|bonds?|yields?|treasur(?:y|ies)|dividend|buyback|short(?:s|ing| interest| seller)?|merger|acquisition|acquire[sd]?|takeover|buyout|ipo|spin-?off|bankrupt\w*|default|downgrade[sd]?|upgrade[sd]?|price target|fda|approval|recall|tariffs?|sanctions?|export controls?|antitrust|lawsuit|sec\b|fraud|restate\w*|layoffs?|capex|data cent(?:er|re)s?|chips?|semiconductors?|oil|crude|opec|gas|gold|copper|inflation|cpi|jobs report|payrolls|fed\b|rate (?:cut|hike)s?|central bank|ecb|boj|supply chain|shortage|demand|pricing|orders?|backlog|contract|ceo|cfo)\b/gi;
const NAMED = /\$[A-Z]{1,5}\b|\((?:NYSE|NASDAQ|Nasdaq|AMEX)\s*:\s*[A-Z]{1,5}\)|\b(?:Inc|Corp|Ltd|PLC|plc|Co)\b\.?/g;
const OFF_TOPIC = /\b(election|ballot|campaign|senate|congress(?:man|woman)?|immigration|border|abortion|crime|shooting|trial|verdict|celebrity|royal|sports?|football|nfl|nba|movie|music|weather|podcast|opinion|op-ed|obituary)\b/gi;

/** Pure: a rough market-relevance score for an article from its title and summary. */
export function relevance(a: PickArticle): number {
  const text = `${a.title} ${a.summary ?? ""}`;
  const n = (re: RegExp) => new Set((text.match(re) ?? []).map((m) => m.toLowerCase())).size;
  return n(NAMED) * 3 + n(MARKET) * 2 - n(OFF_TOPIC) * 2 + (n(MARKET) > 0 && /\d/.test(a.title) ? 1 : 0);
}

/** Pure: the articles to read now (the most relevant, newest first among equals) and the ones left for another day. */
export function pickArticles<T extends PickArticle>(articles: T[], max: number): { read: T[]; skipped: T[] } {
  if (articles.length <= max) return { read: articles, skipped: [] };
  const ranked = articles.map((a, i) => ({ a, i, s: relevance(a) })).sort((x, y) => y.s - x.s || x.i - y.i);
  const chosen = new Set(ranked.slice(0, max).map((x) => x.i));
  return { read: articles.filter((_, i) => chosen.has(i)), skipped: articles.filter((_, i) => !chosen.has(i)) };
}

export interface PickIdea { term: string; tickers?: string[]; sources?: string[] }

/**
 * Pure: each article's own result. An idea belongs to the articles the model cited for it; when it cited none, to
 * the articles whose title or text names one of its tickers; an idea that cannot be placed is shown on every article
 * read, as before. An article with no idea says so.
 */
export function articleOutcomes(articles: Array<PickArticle & { text?: string }>, ideas: PickIdea[], prefix = "read"): Map<string, string> {
  const urls = new Set(articles.map((a) => a.url));
  const names = (a: PickArticle & { text?: string }, i: PickIdea) => (i.tickers ?? []).some((t) => new RegExp(`(?<![A-Za-z0-9])\\$?${t.replace(/[.]/g, "\\.")}(?![A-Za-z0-9])`).test(`${a.title} ${a.summary ?? ""} ${a.text ?? ""}`));
  // Where each idea came from: the articles cited for it, else those naming its tickers, else (not attributable) every article read.
  const from = ideas.map((i) => {
    const cited = (i.sources ?? []).filter((u) => urls.has(u));
    if (cited.length) return new Set(cited);
    const named = articles.filter((a) => names(a, i)).map((a) => a.url);
    return new Set(named.length ? named : articles.map((a) => a.url));
  });
  const out = new Map<string, string>();
  for (const a of articles) {
    const mine = ideas.filter((_, k) => from[k].has(a.url));
    out.set(a.url, mine.length ? `${prefix}: ${mine.map((i) => i.term).join("; ")}` : `${prefix}: no tradeable idea`);
  }
  return out;
}
