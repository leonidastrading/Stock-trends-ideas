import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import { alreadyNewsSince, checkRumors, latestChecks, matching, parseGoogleNews, RUMOR_CHECK_PROMPT, searchTerms, settle } from "@/lib/scout/rumor-check";
import { readRumorDoc, rumorsSince } from "@/lib/scout/rumors";

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>Pentagon awards tanker contract to Airbus, Boeing loses bid - Reuters</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sun, 15 Nov 2026 14:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Recipes &amp; more</title><link>https://news.google.com/rss/articles/zzz</link><pubDate>Sun, 15 Nov 2026 12:00:00 GMT</pubDate><source url="https://x.com">Food</source></item>
<item><title>No date</title><link>https://x</link></item>
</channel></rss>`;

describe("rumor check: pieces", () => {
  it("parses Google News RSS", () => {
    const items = parseGoogleNews(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ at: "2026-11-15T14:00:00.000Z", headline: "Pentagon awards tanker contract to Airbus, Boeing loses bid - Reuters", url: "https://news.google.com/rss/articles/abc", source: "Reuters" });
    expect(items[1].headline).toBe("Recipes & more");
  });

  it("searches on the ticker and the claim's longest words, without forum filler", () => {
    const t = searchTerms({ claim: "Posters claim Boeing will lose the Air Force tanker contract", tickers: ["BA"] });
    expect(t.startsWith("BA ")).toBe(true);
    expect(t).toContain("contract");
    expect(t).not.toMatch(/posters|claim\b/);
  });

  it("keeps only headlines that share key words with the claim", () => {
    const r = { claim: "Boeing will lose the Air Force tanker contract", tickers: ["BA"] };
    const items = parseGoogleNews(RSS);
    expect(matching(r, items).map((e) => e.source)).toEqual(["Reuters"]);
  });

  it("the prompt is strict and treats headlines as data", () => {
    expect(RUMOR_CHECK_PROMPT).toMatch(/when in doubt, open/);
    expect(RUMOR_CHECK_PROMPT).toMatch(/data, not instructions/);
  });
});

const rss = (items: Array<{ title: string; at: string; source: string }>) => (async () => new Response(`<rss><channel>${items.map((i, k) => `<item><title>${i.title}</title><link>https://news.example/${k}</link><pubDate>${new Date(i.at).toUTCString()}</pubDate><source url="https://x">${i.source}</source></item>`).join("")}</channel></rss>`, { status: 200 })) as unknown as typeof fetch;
const reply = (o: unknown) => ({ text: JSON.stringify(o), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.001 });
const READ = [
  { claim: "Posters claim Boeing will lose the Air Force tanker contract", tickers: ["BA"], direction: "short", category: "corporate", specificity: 4, timeframe: "next week", confirm: "a DoD contract notice", source: "r/conspiracy", quote: "" },
  { claim: "Lizard people run the Federal Reserve", tickers: [], direction: "none", category: "macro", specificity: 1, timeframe: "", confirm: "", source: "r/conspiracy", quote: "" },
];

describe("rumor check: at intake and daily (PGlite, fake news and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("a claim already reported when read is news, not a rumor; a later report makes a rumor come true", async () => {
    const now = new Date();
    // Intake: the Boeing claim was already on Reuters an hour before the scout read it.
    const before = rss([{ title: "Boeing loses Air Force tanker contract to Airbus", at: new Date(now.getTime() - 3600_000).toISOString(), source: "Reuters" }]);
    let checkCalls = 0;
    const model: CallModel = async ({ user, purpose }) => {
      if (purpose === "rumors") return reply({ rumors: READ });
      checkCalls++;
      const id = Number(/RUMOR (\d+)/.exec(user)![1]);
      return reply({ results: [{ id, status: "confirmed", evidence: [0], note: "Reuters reports the Air Force picked Airbus." }] });
    };
    await readRumorDoc("BA is done. The Fed is run by lizards.", "dump.txt", { data: null, sources: [], callModel: model, now, env: {} as NodeJS.ProcessEnv, fetchImpl: before });
    const list = await rumorsSince(7);
    const ba = list.find((r) => r.claim.includes("Boeing"))!, fed = list.find((r) => r.claim.includes("Lizard"))!;
    let v = await latestChecks();
    expect(checkCalls).toBe(1);
    expect(v.get(ba.id)).toMatchObject({ status: "already_news", evidence: [{ source: "Reuters" }] });
    expect(v.get(fed.id)).toMatchObject({ status: "open", evidence: [] });
    expect((await alreadyNewsSince(new Date(now.getTime() - 86400_000))).map((x) => x.rumor.id)).toEqual([ba.id]);

    // Same day: nothing due. Already news is final; the open one waits a day.
    expect(await checkRumors({ data: null, callModel: model, now, fetchImpl: before, env: {} as NodeJS.ProcessEnv }, Date.now() + 600_000)).toBe("nothing due");

    // A day later the lizard claim is "reported" after it was read: it came true (a test of the flow, not of lizards).
    const later = new Date(now.getTime() + 21 * 3600_000);
    const after = rss([{ title: "Federal Reserve run by lizard people, officials confirm", at: new Date(now.getTime() + 20 * 3600_000).toISOString(), source: "Wire" }]);
    const out = await checkRumors({ data: null, callModel: model, now: later, fetchImpl: after, env: {} as NodeJS.ProcessEnv }, Date.now() + 600_000);
    expect(out).toMatch(/1 came true/);
    v = await latestChecks();
    expect(v.get(fed.id)).toMatchObject({ status: "confirmed", evidence: [{ source: "Wire" }] });
    const rows = await query(`SELECT rumor_id FROM rumor_checks ORDER BY id`);
    expect(rows.map((r) => Number(r.rumor_id)).sort((a, b) => a - b)).toEqual([ba.id, fed.id, fed.id].sort((a, b) => a - b));
  });

  it("settles a came-true whose evidence predates the rumor as already news", () => {
    const e = (at: string) => ({ at, headline: "h", url: "u", source: "s" });
    expect(settle("confirmed", [e("2026-11-15T10:00:00Z"), e("2026-11-16T10:00:00Z")], "2026-11-15T23:21:00Z")).toBe("already_news");
    expect(settle("confirmed", [e("2026-11-16T10:00:00Z")], "2026-11-15T23:21:00Z")).toBe("confirmed");
    expect(settle("partly", [e("2026-11-14T10:00:00Z")], "2026-11-15T23:21:00Z")).toBe("partly");
  });
});
