import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { queueEvidence, runEvidenceArchive, savedCopies, urlsIn } from "@/lib/scout/evidence-archive";
import type { ResearchDeps } from "@/lib/scout/research";
import { pickPages, runSiteWatch, siteChanges, siteDiff } from "@/lib/scout/site-watch";
import * as store from "@/lib/scout/store";
import { isoTs, pageAsOf, parseCdx, parsePageRef, tsIso } from "@/lib/sources/wayback";
import { sampleCard } from "./card.test";

const HOME = `<html><body><nav>
  <a href="/investors">Investor Relations</a> <a href="/company/customers/">Our customers</a> <a href="https://careers.acme.com/jobs">Careers</a>
  <a href="https://evilacme.com/pricing">Pricing</a> <a href="/products#top">Products</a> <a href="mailto:x@acme.com">Mail</a>
  <a href="/press">Newsroom</a> <a href="/investors">IR again</a></nav></body></html>`;

const page = (lines: string[]) => `<html><body>${lines.map((l) => `<p>${l}</p>`).join("")}</body></html>`;
const SAME = ["Acme builds industrial robots for warehouses around the world.", "Founded in 1998, we are headquartered in Denver, Colorado."];
const OLD_CUSTOMERS = [...SAME, "Trusted by Walmart, Target and Costco for fulfilment automation at scale.", "Our largest customer, Walmart, has deployed 4,000 Acme robots since 2021."];
const NEW_CUSTOMERS = [...SAME, "Trusted by Target and Costco for fulfilment automation at scale.", "Join hundreds of companies automating their warehouses with Acme today."];

describe("Wayback and website helpers (pure)", () => {
  it("converts timestamps and parses page references", () => {
    expect(tsIso("20250301123456")).toBe("2025-03-01T12:34:56Z");
    expect(isoTs("2025-03-01")).toBe("20250301");
    expect(parsePageRef("https://acme.com/customers @ 2025-03-01", "2026-11-23")).toEqual({ url: "https://acme.com/customers", date: "2025-03-01" });
    expect(parsePageRef("https://acme.com/customers", "2026-11-23")).toEqual({ url: "https://acme.com/customers", date: "2026-11-23" });
    expect(parsePageRef("acme customers page", "2026-11-23")).toBeNull();
  });

  it("parses CDX rows", () => {
    const rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ["com,acme)/", "20250301000000", "https://acme.com/", "text/html", "200", "ABC", "100"], ["bad", "2025", "x", "", "", "", ""]];
    expect(parseCdx(rows)).toEqual([{ ts: "20250301000000", url: "https://acme.com/", status: "200", digest: "ABC" }]);
    expect(parseCdx({})).toEqual([]);
  });

  it("picks one page per kind on the company's own domain", () => {
    const pages = pickPages("https://www.acme.com", HOME);
    expect(pages).toEqual([
      { kind: "home", url: "https://www.acme.com/" },
      { kind: "investors", url: "https://www.acme.com/investors" },
      { kind: "press", url: "https://www.acme.com/press" },
      { kind: "customers", url: "https://www.acme.com/company/customers" },
      { kind: "careers", url: "https://careers.acme.com/jobs" },
      { kind: "products", url: "https://www.acme.com/products" },
    ]);
    // evilacme.com is not acme.com
    expect(pages.some((p) => p.url.includes("evilacme"))).toBe(false);
  });

  it("finds the removed and added lines, ignoring dates and times", () => {
    const d = siteDiff(OLD_CUSTOMERS.join("\n"), NEW_CUSTOMERS.join("\n"));
    expect(d.removed).toEqual(OLD_CUSTOMERS.slice(2));
    expect(d.added).toEqual(NEW_CUSTOMERS.slice(2));
    expect(d.changedChars).toBeGreaterThan(100);
    expect(siteDiff("Updated 2026-11-01 at 10:30: prices are listed below for all plans.", "Updated 2026-11-20 at 09:15: prices are listed below for all plans.").changedChars).toBe(0);
  });

  it("lists the web addresses cited, leaving archive and chart links out", () => {
    const text = JSON.stringify({ evidence: [{ url: "https://acme.com/news/1." }, { url: "https://web.archive.org/web/2025/https://acme.com" }], note: "see https://sec.gov/x, and https://acme.com/news/1 and /api/chart/ACME" });
    expect(urlsIn(text)).toEqual(["https://acme.com/news/1", "https://sec.gov/x"]);
  });

  it("reads a page as it was on a date", async () => {
    const f = (async (u: string) => {
      if (u.startsWith("https://archive.org/wayback/available")) {
        expect(u).toContain("timestamp=20250301");
        return Response.json({ archived_snapshots: { closest: { available: true, timestamp: "20250228101010", url: "https://web.archive.org/web/20250228101010/https://acme.com/customers" } } });
      }
      if (u === "https://web.archive.org/web/20250228101010id_/https://acme.com/customers") return new Response(page(OLD_CUSTOMERS));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = await pageAsOf("https://acme.com/customers @ 2025-03-01", "2026-11-23", (h) => h.replace(/<[^>]+>/g, " "), f);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ date: "2025-02-28", url: "https://web.archive.org/web/20250228101010/https://acme.com/customers" });
    expect(r.rows[0].detail).toContain("Our largest customer, Walmart");
  });
});

describe("site watch and evidence saving (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => { setQuerierForTests(null); vi.unstubAllGlobals(); });

  it("reads an open-card company's pages, compares with the archive copy, has the AI read the change and saves the new version", async () => {
    const v = await store.ensureVersion("h", "m", "high", {});
    const c = await store.insertCard({ versionId: v.id, origin: "scout", card: sampleCard(), model: "m", modelServed: null, prompt: "", replyText: "", usage: null, costUsd: null, status: "promoted", gateNotes: [], catalystDate: null, rankScore: 15 });
    await store.insertTrack({ cardId: c.id, symbol: "ACME", sectorEtf: "XLI", direction: "long", cardDate: "2026-11-20", deadlineDate: "2026-12-20" });
    const saves: string[] = [];
    vi.stubGlobal("fetch", (async (u: string) => {
      if (u.startsWith("https://finnhub.io/")) return Response.json({ weburl: "https://www.acme.com" });
      if (u.startsWith("https://archive.org/wayback/available")) {
        const url = new URL(u).searchParams.get("url")!;
        return Response.json({ archived_snapshots: { closest: { available: true, timestamp: "20260825000000", url: `https://web.archive.org/web/20260825000000/${url}` } } });
      }
      if (u.startsWith("https://web.archive.org/web/20260825000000id_/")) {
        const url = u.split("id_/")[1];
        return new Response(url.endsWith("/customers") ? page(OLD_CUSTOMERS) : url.endsWith("acme.com/") ? HOME + page(SAME) : page(SAME));
      }
      if (u.startsWith("https://web.archive.org/save/")) { saves.push(u); return new Response("", { status: 302, headers: { location: `/web/20261123000000/${u.slice(29)}` } }); }
      if (u === "https://www.acme.com" || u === "https://www.acme.com/") return new Response(HOME + page(SAME), { headers: { "content-type": "text/html" } });
      if (u.endsWith("/customers")) return new Response(page(NEW_CUSTOMERS), { headers: { "content-type": "text/html" } });
      if (u.includes("acme.com")) return new Response(page(SAME), { headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch);
    const prompts: string[] = [];
    const deps = {
      now: new Date("2026-11-23T15:00:00Z"), env: { FINNHUB_API_KEY: "k" } as unknown as NodeJS.ProcessEnv,
      callModel: async (a: { user: string; purpose?: string }) => {
        prompts.push(a.user);
        expect(a.purpose).toBe("site_change");
        return { text: JSON.stringify({ direction: "negative", headline: "Walmart, its largest named customer, was removed from the customers page.", findings: [{ what: "Walmart dropped from the customer list", quote: "Trusted by Walmart, Target and Costco" }] }), stopReason: "end_turn", modelServed: "h", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.001 };
      },
    } as unknown as ResearchDeps;

    expect(await runSiteWatch(deps)).toBe("site watch: ACME: 6 pages, 1 changed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("- Our largest customer, Walmart, has deployed 4,000 Acme robots since 2021.");
    expect(saves).toEqual(["https://web.archive.org/save/https://www.acme.com/company/customers"]);
    const [ch] = await siteChanges(["ACME"]);
    expect(ch).toMatchObject({ kind: "customers", oldDate: "2026-08-25", oldUrl: "https://web.archive.org/web/20260825000000/https://www.acme.com/company/customers", newUrl: "https://web.archive.org/web/20261123000000/https://www.acme.com/company/customers" });
    expect(ch.read?.direction).toBe("negative");
    // A week has not passed: nothing is due.
    expect(await runSiteWatch(deps)).toBe("site watch: nothing due");
  });

  it("queues cited addresses once per citer and saves them a few at a time", async () => {
    expect(await queueEvidence(["https://acme.com/a", "https://acme.com/b"], "card:1")).toBe(2);
    expect(await queueEvidence(["https://acme.com/a"], "investigation:4")).toBe(0);
    expect(await queueEvidence(["https://acme.com/a"], "card:1")).toBe(0);
    const f = (async (u: string) => (u.endsWith("/b") ? new Response("", { status: 429 }) : new Response("", { status: 200, headers: { "content-location": `/web/20261123010101/${u.slice(29)}` } }))) as unknown as typeof fetch;
    expect(await runEvidenceArchive(f)).toBe("evidence: 1 of 2 saved to the Wayback Machine");
    expect(await savedCopies("investigation:4")).toEqual([{ url: "https://acme.com/a", archiveUrl: "https://web.archive.org/web/20261123010101/https://acme.com/a" }]);
    expect((await savedCopies("card:1")).map((x) => x.archiveUrl)).toEqual(["https://web.archive.org/web/20261123010101/https://acme.com/a", null]);
  });
});
