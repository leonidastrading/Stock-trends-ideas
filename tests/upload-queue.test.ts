import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { importResearchInput } from "@/lib/scout/importer";
import { parseInboxReply } from "@/lib/scout/inbox";
import { finishRequest, isStale, listRequests, startRequest } from "@/lib/scout/research-requests";

const idea = (i: number) => ({ observation: `Stock ${i} has a catalyst in March with its own facts and numbers.`, term: `Idea ${i}`, kind: "event", tickers: [`T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`], direction: "long", catalyst_date: "", confirmed: "" });

describe("a document that covers many stocks", () => {
  it("keeps twelve ideas by default and as many as asked for an upload", () => {
    const reply = JSON.stringify({ ideas: Array.from({ length: 30 }, (_, i) => idea(i)) });
    expect(parseInboxReply(reply)).toHaveLength(12);
    expect(parseInboxReply(reply, 24)).toHaveLength(24);
  });

  it("an idea waiting in line is researched with the same input as one researched at once", () => {
    const [it0] = parseInboxReply(JSON.stringify({ ideas: [idea(1)] }));
    const input = importResearchInput({ ...it0, source: "you" }, "uploaded biotech.pdf 2026-11-26");
    expect(input).toMatchObject({ origin: "human", term: "Idea 1", kindHint: "event", tickersHint: ["TBA"] });
    expect(input.observation).toContain("Stock 1 has a catalyst in March");
  });
});

describe("ideas waiting in line on the Research tab (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("shows as waiting (never as 'did not finish'), then takes its result", async () => {
    const id = await startRequest({ term: "Beam base editing", tickers: ["BEAM"], from: { label: "Uploaded document", url: "/research" } }, "queued");
    let [r] = await listRequests();
    expect([r.status, r.tickers, r.fromLabel]).toEqual(["queued", ["BEAM"], "Uploaded document"]);
    // Hours later it is still only waiting.
    expect(isStale(r, new Date(Date.now() + 3 * 3600_000))).toBe(false);
    await finishRequest(id, { outcome: "card", cardId: 420, status: "promoted" });
    [r] = await listRequests();
    expect([r.status, r.cardId, r.cardStatus]).toEqual(["card", 420, "promoted"]);
  });
});
