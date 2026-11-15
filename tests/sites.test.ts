import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { articleLinks, cleanSiteUrl, feedLink, htmlText, parseFeed } from "@/lib/sources/site";
import { importObservation, importTerm, type ImportItem } from "@/lib/scout/importer";
import type { CallModel } from "@/lib/scout/llm";
import { playerOf } from "@/lib/scout/scoreboard";
import { addSite, checkSite } from "@/lib/scout/sites";
import * as store from "@/lib/scout/store";

const rss = (items: Array<[string, string, string]>) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Chip Notes</title>${items.map(([t, l, d]) => `<item><title><![CDATA[${t}]]></title><link>${l}</link><pubDate>${d}</pubDate><description>&lt;p&gt;${t} &amp;amp; more detail.&lt;/p&gt;</description></item>`).join("")}</channel></rss>`;
const atom = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Grid transformer lead times hit 4 years</title><link rel="alternate" href="/2026/11/transformers"/><updated>2026-11-14T10:00:00Z</updated><summary>Utilities wait.</summary></entry></feed>`;
const page = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>
  <nav><a href="/about">About us and our long mission statement here</a></nav>
  <a href="/2026/11/14/hbm-supply-sold-out-through-2027">HBM supply sold out through 2027, says SK Hynix</a>
  <a href="/tag/memory">Memory stories and everything else tagged memory</a>
  <a href="https://other.com/2026/11/x-y-z">An outside link with a long enough headline</a>
  <a href="/news/markets/copper-prices-jump-on-chile-mine-strike">Copper prices jump on Chile mine strike</a>
  <a href="/short">Short</a></body></html>`;

describe("reading a website", () => {
  it("accepts public web addresses only", () => {
    expect(cleanSiteUrl("semianalysis.com")).toBe("https://semianalysis.com/");
    expect(cleanSiteUrl("https://www.example.com/news#top")).toBe("https://www.example.com/news");
    for (const bad of ["", "localhost:3000", "http://127.0.0.1/", "file:///etc/passwd", "https://user:pw@example.com", "http://intranet/", "https://x.internal/a", "https://example.com:8443/"]) expect(cleanSiteUrl(bad)).toBeNull();
  });

  it("parses RSS and Atom, newest first", () => {
    const items = parseFeed(rss([["Older post", "https://chips.example/a", "Mon, 10 Nov 2026 10:00:00 GMT"], ["Newer post", "https://chips.example/b", "Thu, 13 Nov 2026 10:00:00 GMT"]]), "https://chips.example/feed");
    expect(items.map((i) => i.title)).toEqual(["Newer post", "Older post"]);
    expect(items[0]).toMatchObject({ url: "https://chips.example/b", published: "2026-11-13T10:00:00.000Z", summary: "Newer post & more detail." });
    expect(parseFeed(atom, "https://grid.example/feed")[0]).toMatchObject({ url: "https://grid.example/2026/11/transformers", title: "Grid transformer lead times hit 4 years", summary: "Utilities wait." });
  });

  it("finds an advertised feed, or the article links on the page", () => {
    expect(feedLink(page, "https://news.example/")).toBe("https://news.example/feed.xml");
    expect(articleLinks(page, "https://news.example/").map((a) => a.url)).toEqual(["https://news.example/2026/11/14/hbm-supply-sold-out-through-2027", "https://news.example/news/markets/copper-prices-jump-on-chile-mine-strike"]);
    expect(htmlText("<p>A &amp; B</p><script>x()</script><p>C</p>")).toBe("A & B\nC");
  });

  it("ideas from a site are the scout's, under their own player", () => {
    const it = { observation: "HBM sold out", term: "HBM shortage", kind: "event", tickers: ["MU"], source: "site" } as ImportItem;
    expect(importTerm(it)).toBe("site: HBM shortage");
    expect(playerOf("scout", importTerm(it))).toBe("scout_sites");
    expect(importObservation(it, "Chip Notes")).toContain("(From Chip Notes; an idea the scout read in a new article on a website Vadim follows.)");
  });
});

describe("following a website", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("records what is there when added, then reads only new articles and sends their ideas to research", async () => {
    let feed = rss([["Old news", "https://chips.example/old", "Mon, 10 Nov 2026 10:00:00 GMT"]]);
    const fetchImpl = (async (url: string) => {
      if (url === "https://chips.example/") return new Response(`<html><head><link rel="alternate" type="application/atom+xml" href="/feed"></head></html>`);
      if (url === "https://chips.example/feed") return new Response(feed);
      if (url === "https://chips.example/new") return new Response("<html><article><p>Micron raised HBM prices 20% for 2027 contracts.</p></article></html>");
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { site, found } = await addSite("chips.example", "Chip Notes", fetchImpl);
    expect(found).toBe(1);
    expect(site).toMatchObject({ label: "Chip Notes", via: "feed", feedUrl: "https://chips.example/feed", status: "ok" });
    await expect(addSite("https://chips.example/", undefined, fetchImpl)).rejects.toThrow("already on the list");

    let seen = "";
    const callModel: CallModel = async ({ user }) => {
      seen = user;
      return { text: JSON.stringify({ ideas: [{ observation: "Micron raised HBM prices 20% for 2027", term: "Micron HBM price hike", kind: "event", tickers: ["MU"], direction: "long", catalyst_date: "", confirmed: "" }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const deps = { data: null, sources: [], callModel, now: new Date("2026-11-15T15:00:00Z"), env: {} as NodeJS.ProcessEnv };
    const sent: Array<{ items: ImportItem[]; label: string }> = [];
    const deliver = async (items: ImportItem[], label: string) => (sent.push({ items, label }), `${items.length} sent`);

    expect(await checkSite((await store.getSite(site.id))!, deps, deliver, fetchImpl)).toMatchObject({ status: "ok", newArticles: 0 });
    expect(sent).toHaveLength(0);

    feed = rss([["Micron lifts HBM prices", "https://chips.example/new", "Sat, 15 Nov 2026 09:00:00 GMT"], ["Old news", "https://chips.example/old", "Mon, 10 Nov 2026 10:00:00 GMT"]]);
    const r = await checkSite((await store.getSite(site.id))!, deps, deliver, fetchImpl);
    expect(r).toMatchObject({ newArticles: 1, read: 1, ideas: 1 });
    expect(seen).toContain("Micron raised HBM prices 20% for 2027 contracts.");
    expect(sent[0].label).toBe("Chip Notes");
    expect(sent[0].items[0]).toMatchObject({ source: "site", tickers: ["MU"], sources: ["https://chips.example/new"] });
    const arts = await store.recentSiteArticles();
    expect(arts.map((a) => [a.title, a.outcome])).toEqual([["Micron lifts HBM prices", "read: Micron HBM price hike"], ["Old news", "already there when added"]]);
    expect((await store.getSite(site.id))!.detail).toBe("1 new, 1 read, 1 idea(s) sent to research");

    await store.deleteSite(site.id);
    expect(await store.listSites()).toEqual([]);
    expect(await store.recentSiteArticles()).toEqual([]);
  });
});

describe("site read failures in plain words", () => {
  it("names a bot check, a login wall and a missing page", async () => {
    const { friendlyError } = await import("@/lib/scout/sites");
    const { HttpError } = await import("@/lib/http");
    expect(friendlyError(new HttpError("rumble.com 403: Just a moment...", 403, "<title>Just a moment...</title>"))).toMatch(/^This site blocks automated readers with a bot check/);
    expect(friendlyError(new Error("example.com 401: Unauthorized"))).toMatch(/needs a login/);
    expect(friendlyError(new Error("example.com 404: Not Found"))).toBe("That page was not found; check the address.");
    expect(friendlyError(new Error("odd failure"))).toBe("odd failure");
  });
});
