/**
 * Your websites: sites Vadim added in Settings. Once a day each is read (feed first,
 * page links otherwise); articles that are new since the last read are read by the
 * model for trade ideas, and those ideas go to research as the "your websites" player.
 * Articles already on the site when it was added are recorded; "Read the latest 10" (on adding, or any time) reads
 * the newest ten articles or PDF reports now. Everything read is also kept as a digest (stocks, summary, claims)
 * that research, Dots, the chat and cards use (lib/scout/site-digest.ts).
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
  const read = await readSite(url, null, fetchImpl).catch((err) => { throw new Error(friendlyError(err)); });
  const detail = `${read.articles.length} articles via ${read.via === "feed" ? `its feed (${read.feedUrl})` : "the links on the page"}; new ones are read from the next daily check`;
  const site = await store.insertSite({ url, label: label?.trim().slice(0, 60) || host(url), kind, feedUrl: read.feedUrl, via: read.via, status: "ok", detail });
  await store.addSiteArticles(site.id, read.articles, true);
  return { site, found: read.articles.length };
}

/** Pure: a site read failure in plain words (a bot check, a login wall, a missing page). */
export function friendlyError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const body = err && typeof err === "object" && "body" in err ? String((err as { body: unknown }).body).slice(0, 4000) : "";
  if (/just a moment|cf-chl|challenge-platform|attention required|cloudflare|captcha|are you a robot|access denied/i.test(`${m} ${body}`)) return "This site blocks automated readers with a bot check (Cloudflare or similar), so the scout cannot read it. Save pages from it and paste or upload them on the Rumors tab (or drop them in the inbox repo's rumors/ folder) instead.";
  if (/\b(401|403)\b/.test(m)) return "This site refused the scout (it needs a login or blocks automated readers). Save pages and paste or upload them on the Rumors tab instead.";
  if (/\b404\b/.test(m)) return "That page was not found; check the address.";
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return "That web address does not exist.";
  if (/abort|timed? ?out/i.test(m)) return "The site did not answer in time; try again later.";
  return m;
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
    const error = friendlyError(err).slice(0, 300);
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
  // Kept as digests for research, Dots, the chat and cards (best effort; a spent budget leaves them out).
  await import("./site-digest").then(({ digestArticles }) => digestArticles(site, withText, deps)).catch(() => 0);
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

export const LATEST = { articles: 10, ideas: 4, chars: 5000 };

/**
 * Read a site's newest articles or PDF reports now (by default 10, whether or not they were already there when the
 * site was added): digests kept for research, Dots, chat and cards; a rumors site's claims go to the Rumors tab,
 * an ideas site's trade ideas to research (up to 4).
 */
export async function readLatest(site: store.Site, deps: ResearchDeps, deliver: (items: ImportItem[], label: string) => Promise<string>, n = LATEST.articles, fetchImpl?: typeof fetch): Promise<string> {
  let read;
  try {
    read = await readSite(site.url, site.feedUrl, fetchImpl);
  } catch (err) {
    const error = friendlyError(err).slice(0, 300);
    await store.siteChecked(site.id, "down", error);
    return `${site.label}: ${error}`;
  }
  await store.addSiteArticles(site.id, read.articles, false);
  const latest = read.articles.slice(0, n);
  if (!latest.length) return `${site.label}: nothing to read`;
  const withText = await Promise.all(latest.map(async (a) => ({ ...a, text: read.via === "feed" && a.summary.length > 600 ? a.summary : await articleText(a.url, LATEST.chars, fetchImpl) })));
  const parts: string[] = [];
  const digested = await import("./site-digest").then(({ digestArticles }) => digestArticles(site, withText, deps)).catch((e) => { parts.push(e instanceof Error && e.message === "capped" ? "digests waiting for the AI budget" : `digests failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`); return 0; });
  parts.unshift(`${latest.length} read (${withText.filter((a) => a.text).length} with text), ${digested} kept for research`);
  const doc = withText.map((a) => `--- ${a.title}\nURL: ${a.url}${a.published ? `\nPublished: ${a.published.slice(0, 10)}` : ""}\n${a.text || a.summary}`).join("\n\n");
  try {
    if (site.kind === "rumors") {
      const { readRumorDoc } = await import("./rumors");
      const r = await readRumorDoc(doc, `${site.label} (latest ${latest.length})`, { ...deps, data: deps.data ?? null });
      parts.push(`${r.rumors} rumor(s) to the Rumors tab${r.error ? ` (${r.error})` : ""}`);
      await store.setArticleOutcome(latest.map((a) => a.url), `read (latest ${n}): ${r.rumors} rumor(s)`);
    } else {
      const { ideasFrom } = await import("./inbox");
      const { items } = await ideasFrom(articlesDocument(site.label, withText), `the latest articles on ${site.label}`, deps);
      const ideas = items.slice(0, LATEST.ideas).map((it) => ({ ...it, source: "site" as const, sources: [...new Set([...(it.sources ?? []), ...latest.map((a) => a.url)])].slice(0, 10) }));
      parts.push(ideas.length ? await deliver(ideas, site.label.slice(0, 40)) : "no tradeable idea");
      await store.setArticleOutcome(latest.map((a) => a.url), ideas.length ? `read (latest ${n}): ${ideas.map((i) => i.term).join("; ")}` : `read (latest ${n}): no tradeable idea`);
    }
  } catch (err) {
    parts.push(`ideas not read: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
  }
  const line = `${site.label}: ${parts.join("; ")}`;
  await store.siteChecked(site.id, "ok", line.slice(0, 300), { feedUrl: read.feedUrl, via: read.via });
  return line;
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
