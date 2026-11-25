/** Wikipedia pageviews: last 7 days' average views against the trailing 12-month average. Free, no key. */
import { getJson } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Source } from "./types";

const UA = { "user-agent": "trend-scout/0.1 (research dashboard)" };

export async function findArticle(term: string, fetchImpl?: typeof fetch): Promise<string | null> {
  const r = await getJson<{ query?: { search?: Array<{ title: string }> } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=${encodeURIComponent(term)}`,
    { headers: UA, fetchImpl },
  );
  return r.query?.search?.[0]?.title ?? null;
}

/**
 * Pure: whether a term is a desk's own label rather than a topic ("story: ASH → ASH", "filing: X 8-K 5.02",
 * "insider: KGS"). Searching Wikipedia for a label finds whatever shares a word with it: card #394's "story: ASH → ASH"
 * was measured on a film's article.
 */
export const isDeskLabel = (term: string) => /^[a-z][a-z+ ]{2,24}:\s/.test(term) || term.includes("→");

const SUFFIX = /,?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|holdings?|group|sa|ag|nv|se|the|class [a-c]|common stock|ordinary shares|american depositary shares?)\.?(?=\s|,|$)/gi;
const COMPANY = /\b(compan(?:y|ies)|corporation|manufacturer|multinational|conglomerate|headquartered|nyse|nasdaq|publicly traded|holding|retailer|bank|maker|provider|firm|pharmaceutical|biotech\w*|airline|software|semiconductor|chemicals?|insurer|utility|developer|producer|operator|chain|brand)\b/i;
const NOT_COMPANY = /\b(film|album|song|novel|television series|tv series|episode|band|footballer|actor|actress|singer|village|city in|town in|county|river|disambiguation)\b/i;

/** Pure: the search result that is the company's own article (its title shares a word of the name and it reads like a company), or null. */
export function pickCompanyArticle(name: string, results: Array<{ title: string; snippet?: string }>): string | null {
  const words = name.replace(SUFFIX, " ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  for (const r of results) {
    const title = r.title.toLowerCase(), text = (r.snippet ?? "").replace(/<[^>]+>/g, " ");
    if (!words.some((w) => title.includes(w))) continue;
    // Read the opening of the article: "is an American chemical company", not "is a 2019 film".
    const lead = text.slice(0, 220);
    if (NOT_COMPANY.test(r.title) || (NOT_COMPANY.test(lead) && !COMPANY.test(lead))) continue;
    if (COMPANY.test(lead) || COMPANY.test(r.title)) return r.title;
  }
  return null;
}

/** A listed company's own Wikipedia article, from its name on file; null when none of the top results is clearly the company. */
export async function companyArticle(name: string, fetchImpl?: typeof fetch): Promise<string | null> {
  const clean = name.replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const r = await getJson<{ query?: { search?: Array<{ title: string; snippet?: string }> } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=6&srprop=snippet&srsearch=${encodeURIComponent(`${clean} company`)}`,
    { headers: UA, fetchImpl },
  );
  return pickCompanyArticle(name, r.query?.search ?? []);
}

/** The company's name for a ticker: the scout's own record, else the SEC's company list; null when neither has it. */
async function nameOnFile(symbol: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<string | null> {
  try {
    const { symbolInfo } = await import("../scout/store");
    const name = (await symbolInfo([symbol])).get(symbol)?.name;
    if (name) return name;
  } catch {
    /* no database here: try the SEC's list */
  }
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return null;
  try {
    const { secTickerList } = await import("./edgar");
    return (await secTickerList(ua, fetchImpl)).find((t) => t.ticker === symbol)?.title ?? null;
  } catch {
    return null;
  }
}

/** Pure: 7-day average vs 365-day average from a daily series (oldest first). */
export function pageviewSummary(views: Array<{ date: string; views: number }>) {
  if (views.length < 14) return null;
  const last7 = views.slice(-7);
  const all = views;
  const v7 = last7.reduce((a, b) => a + b.views, 0) / last7.length;
  const v365 = all.reduce((a, b) => a + b.views, 0) / all.length;
  return { v7: r1(v7), v365: r1(v365), asOf: last7[last7.length - 1].date };
}

export const wikipedia: Source = {
  id: "wikipedia",
  label: "Wikipedia pageviews",
  about: "Page-view acceleration for the term's article (7-day average vs 12-month average).",
  configured: () => true,
  probe: (ctx) =>
    guarded("wikipedia", async () => {
      // A desk's label is not a topic: measure the company's own article, or nothing (never a look-alike).
      const label = isDeskLabel(ctx.term) || ctx.subject === "company", symbol = ctx.tickers[0];
      const name = label && symbol ? (ctx.names?.[symbol] ?? (await nameOnFile(symbol, ctx.env, ctx.fetchImpl))) : null;
      const title = label ? (name ? await companyArticle(name, ctx.fetchImpl) : symbol ? null : await findArticle(ctx.term.replace(/^[a-z+ ]+:\s*/, ""), ctx.fetchImpl)) : await findArticle(ctx.term, ctx.fetchImpl);
      if (!title) return { source: "wikipedia", status: "ok", detail: label && symbol ? `no company article found for ${symbol}${name ? ` (${name})` : " (no name on file)"}` : `no article for "${ctx.term}"`, signals: [] };
      const end = daysAgo(ctx.now, 1);
      const start = daysAgo(ctx.now, 366);
      const fmt = (d: Date) => dateStr(d).replace(/-/g, "");
      const r = await getJson<{ items?: Array<{ timestamp: string; views: number }> }>(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/daily/${fmt(start)}/${fmt(end)}`,
        { headers: UA, fetchImpl: ctx.fetchImpl },
      );
      const series = (r.items ?? []).map((i) => ({ date: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`, views: i.views }));
      const s = pageviewSummary(series);
      if (!s) return { source: "wikipedia", status: "ok", detail: `too little history for "${title}"`, signals: [] };
      const ch = change(s.v7, s.v365);
      return {
        source: "wikipedia", status: "ok", signals: [{
          source: "wikipedia", metric: "pageviews_per_day_7d", value: s.v7, baseline: s.v365, changeVs12m: ch, asOf: s.asOf,
          note: `"${title}": ${s.v7.toLocaleString("en-US")} views/day over the last 7 days vs ${s.v365.toLocaleString("en-US")} over 12 months (${pct(ch)})`,
          detail: { article: title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` },
        }],
      };
    }),
};
