import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query as q, setQuerierForTests } from "@/lib/db";
import { knownText, recentWork, whatTheScoutKnows } from "@/lib/scout/known";
import { listInvestigations } from "@/lib/scout/investigate";
import * as store from "@/lib/scout/store";

describe("what the scout's other pages know", () => {
  it("writes the sections under a cap, marked as background, and nothing when there is nothing", () => {
    expect(knownText(["AMD"], [{ title: "AMD: rumors", lines: [] }])).toBeNull();
    const t = knownText(["AMD"], [{ title: "AMD: investigations", lines: ["#3 found X"] }, { title: "AMD: lawsuits", lines: ["y".repeat(500)] }], 300)!;
    expect(t).toMatch(/^WHAT THE SCOUT'S OTHER PAGES ALREADY KNOW about AMD .*not news and not proof/);
    expect(t).toContain("· #3 found X");
    expect(t).toContain("(more left out: AMD: lawsuits)");
  });

  describe("from the database (PGlite)", () => {
    let pg: PGlite;
    beforeAll(() => {
      pg = new PGlite();
      setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    });
    afterAll(() => setQuerierForTests(null));

    it("an investigation that names a stock reaches research and the chat, with what the records confirmed", async () => {
      await listInvestigations(1); // creates the tables
      const report = {
        headline: "Who profits from the outage rules", what_happened: "New outage rules send federal security work to two vendors.",
        money_trail: [{ finding: "PANW won a $40M DHS contract in October", status: "confirmed", source: "USAspending" }, { finding: "Lobbying doubled", status: "unconfirmed", source: "story" }],
        listed: [{ ticker: "PANW", direction: "long", why: "biggest share of the new contracts", catalyst: "DHS awards", catalyst_date: "2026-12-01", confidence: 60 }],
        open_questions: [],
      };
      await q(`INSERT INTO investigations (status, title, input, report, created_at) VALUES ('done', 'outage rules', 'story', $1, '2026-11-18T15:00:00Z')`, [JSON.stringify(report)]);
      const now = new Date("2026-11-19T15:00:00Z");
      const t = (await whatTheScoutKnows(["PANW"], now))!;
      expect(t).toContain("PANW: the user's investigations");
      expect(t).toMatch(/#\d+ 2026-11-18 "Who profits from the outage rules": New outage rules.*Exposure: long PANW, biggest share of the new contracts Catalyst: DHS awards \(2026-12-01\)\. Confirmed by the records: PANW won a \$40M DHS contract in October\./);
      expect(await whatTheScoutKnows(["ZZZZ"], now)).toBeNull();
      const w = await recentWork(now);
      expect(w.investigations[0]).toMatch(/Who profits from the outage rules → long PANW/);
    });

    it("a lawsuit on the Court tab reaches research for that stock", async () => {
      await store.cachePut("court:class-actions", [{ symbol: "PANW", company: "Palo Alto Networks", deadline: "2027-01-08", releases: 6, firms: ["Rosen"], firstSeen: "2026-11-10T00:00:00Z", lastSeen: "2026-11-18T00:00:00Z", headlines: [] }]);
      const t = (await whatTheScoutKnows(["PANW"], new Date("2026-11-19T15:00:00Z")))!;
      expect(t).toContain("securities class action announced (6 law-firm releases, latest 2026-11-18, lead plaintiff deadline 2027-01-08)");
    });
  });
});
