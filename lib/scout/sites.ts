/**
 * Your websites: sites Vadim added in Settings. Once a day each is read (feed first,
 * page links otherwise); articles that are new since the last read are read by the
 * model for trade ideas, and those ideas go to research as the "your websites" player.
 * Articles already on the site when it was added are recorded, never researched.
 */
import { articleText, cleanSiteUrl, readSite, type Article } from "../sources/site";
import type { ImportItem } from "./importer";
import type { ResearchDeps } from "./research";
import * as store from "./store";

export const SITES = {
  /** Hours between reads of one site. */
  everyHours: 20,
  /** New articles read per site per day; the rest are recorded as skipped. */
  maxArticlesPerRead: 6,
  /** Ideas sent to research per site per day. */
  maxIdeasPerRead: 3,
  maxSites: 25,
};

const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");

/** Add a site: read it once now so you see what the scout found, and record what is already there as the starting point. */
export async function addSite(raw: string, label: string | undefined, fetchImpl?: typeof fetch, kind: "ideas" | "rumors" = "ideas"): Promise<{ site: store.Site; found: number }> {
  const url = cleanSiteUrl(raw);
  if (!url) throw new Error("that is not a public web address (try https://example.com/news)");
  const existing = await store.listSites();
  if (existing.some((s) => s.url === url)) throw new Error("that site is already on the list");
  if (existing.length >= SITES.maxSites) throw new Error(`at most ${SITES.maxSites} sites`);
  const read = await readSite(url, null, fetchImpl);
  const detail = `${read.articles.length} articles via ${read.via === "feed" ? `its feed (${read.feedUrl})` : "the links on the page"}; new ones are read from the next daily check`;
  const site = await store.insertSite({ url, label: label?.trim().slice(0, 60) || host(url), kind, feedUrl: read.feedUrl, via: read.via, status: "ok", detail });
  await store.addSiteArticles(site.id, read.articles, true);
  return { site, found: read.articles.length };
}

/** Pure: the document the model reads for one site's new articles. */
export function articlesDocument(label: string, articles: Array<Article & { text: string }>): string {
  return [
    `New articles published on ${label} (a website Vadim follows). Extract the tradeable ideas only: a named company or ETF whose business is changing because of what an article reports. Skip opinion pieces with no new fact, market wraps and ideas with no listed stock.`,
    ...articles.map((a, i) => `--- Article ${i + 1}: ${a.title}\nURL: ${a.url}${a.published ? `\nPublished: ${a.published.slice(0, 10)}` : ""}\n${(a.text || a.summary).slice(0, 3000)}`),
  ].join("\n\n");
}

export interface SiteCheck { site: string; status: string; newArticles?: number; read?: number; ideas?: number; sent?: string; error?: string }

/** Read one site now: record new articles and hand their ideas to research. */
export async function checkSite(site: store.Site, deps: ResearchDeps, deliver: (items: ImportItem[], label: string) => Promise<string>, fetchImpl?: typeof fetch): Promise<SiteCheck> {
  let read;
  try {
    read = await readSite(site.url, site.feedUrl, fetchImpl);
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 200) : String(err);
    await store.siteChecked(site.id, "down", error);
    return { site: site.label, status: "down", error };
  }
  const fresh = new Set(await store.addSiteArticles(site.id, read.articles, false));
  const newOnes = read.articles.filter((a) => fresh.has(a.url));
  const feed = { feedUrl: read.feedUrl, via: read.via };
  if (!newOnes.length) {
    await store.siteChecked(site.id, "ok", `no new articles (${read.articles.length} on the ${read.via === "feed" ? "feed" : "page"})`, feed);
    return { site: site.label, status: "ok", newArticles: 0 };
  }
  const now = newOnes.slice(0, SITES.maxArticlesPerRead);
  await store.setArticleOutcome(newOnes.slice(SITES.maxArticlesPerRead).map((a) => a.url), `skipped: more than ${SITES.maxArticlesPerRead} new in one day`);
  const withText = await Promise.all(now.map(async (a) => ({ ...a, text: read.via === "feed" && a.summary.length > 600 ? a.summary : await articleText(a.url, 3000, fetchImpl) })));
  // A site marked for rumors: its new articles go to the Rumors tab (claims catalogued, nothing researched).
  if (site.kind === "rumors") {
    try {
      const { readRumorDoc } = await import("./rumors");
      const doc = withText.map((a) => `--- ${a.title}\nURL: ${a.url}${a.published ? `\nPublished: ${a.published.slice(0, 10)}` : ""}\n${a.text || a.summary}`).join("\n\n");
      const r = await readRumorDoc(doc, `${site.label} (${now.length} new article${now.length === 1 ? "" : "s"})`, { ...deps, data: deps.data ?? null });
      await store.setArticleOutcome(now.map((a) => a.url), r.error ? `not read: ${r.error}` : `rumors: ${r.rumors} found`);
      await store.siteChecked(site.id, "ok", `${newOnes.length} new, ${now.length} read, ${r.rumors} rumor(s) to the Rumors tab${r.error ? `; ${r.error}` : ""}`, feed);
      return { site: site.label, status: "ok", newArticles: newOnes.length, read: now.length, ideas: 0, sent: `${r.rumors} rumor(s)` };
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 200) : String(err);
      await store.setArticleOutcome(now.map((a) => a.url), `not read: ${error}`);
      await store.siteChecked(site.id, "ok", `${newOnes.length} new; reading failed: ${error}`, feed);
      return { site: site.label, status: "ok", newArticles: newOnes.length, error };
    }
  }
  try {
    const { ideasFrom } = await import("./inbox");
    const { items } = await ideasFrom(articlesDocument(site.label, withText), `new articles on ${site.label}`, deps);
    const ideas = items.slice(0, SITES.maxIdeasPerRead).map((it) => ({ ...it, source: "site" as const, sources: [...new Set([...(it.sources ?? []), ...now.map((a) => a.url)])].slice(0, 10) }));
    const sent = ideas.length ? await deliver(ideas, site.label.slice(0, 40)) : "no tradeable idea";
    await store.setArticleOutcome(now.map((a) => a.url), ideas.length ? `read: ${ideas.map((i) => i.term).join("; ")}` : "read: no tradeable idea");
    await store.siteChecked(site.id, "ok", `${newOnes.length} new, ${now.length} read, ${ideas.length} idea(s) sent to research`, feed);
    return { site: site.label, status: "ok", newArticles: newOnes.length, read: now.length, ideas: ideas.length, sent };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 200) : String(err);
    // Recorded as not read (the reason shows in Settings); the next new articles are tried again tomorrow.
    await store.setArticleOutcome(now.map((a) => a.url), `not read: ${error}`);
    await store.siteChecked(site.id, "ok", `${newOnes.length} new; reading failed: ${error}`, feed);
    return { site: site.label, status: "ok", newArticles: newOnes.length, error };
  }
}

/** The daily pass, from housekeeping: each active site not read in the last `everyHours`, until the deadline. */
export async function checkSites(deps: ResearchDeps, deadline: number, deliver: (items: ImportItem[], label: string) => Promise<string>, fetchImpl?: typeof fetch): Promise<SiteCheck[] | string> {
  const due = (await store.listSites(true)).filter((s) => !s.checkedAt || deps.now.getTime() - Date.parse(s.checkedAt) > SITES.everyHours * 3600_000);
  if (!due.length) return "nothing due";
  const out: SiteCheck[] = [];
  for (const s of due) {
    if (deadline - Date.now() < 45_000) break;
    out.push(await checkSite(s, deps, deliver, fetchImpl));
  }
  return out;
}
