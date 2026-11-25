import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { badgeCounts } from "@/lib/scout/badges";
import * as store from "@/lib/scout/store";

describe("menu badges", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("counts what appeared after each tab was last seen, and skips tabs it was not asked about", async () => {
    await store.cacheGet("x"); // creates the tables
    await pg.query(`INSERT INTO rumor_docs (id, source) VALUES (1, 'r.txt')`);
    await pg.query(`INSERT INTO rumors (doc_id, claim, created_at) VALUES (1, 'old', '2026-11-15T10:00:00Z'), (1, 'new one', '2026-11-16T10:00:00Z'), (1, 'new two', '2026-11-16T11:00:00Z')`);
    await pg.query(`INSERT INTO investigations (status, input, created_at) VALUES ('done', 'x', '2026-11-16T10:00:00Z'), ('running', 'y', '2026-11-16T10:00:00Z')`);
    await store.cachePut("drift:first-seen", { "ACME|2026-11-12": "2026-11-16T09:00:00Z", "OLD|2026-11-01": "2026-11-02T09:00:00Z" });
    const c = await badgeCounts({ rumors: "2026-11-16T00:00:00Z", investigate: "2026-11-16T00:00:00Z", drift: "2026-11-15T00:00:00Z" }, new Date("2026-11-16T12:00:00Z"));
    expect(c).toEqual({ rumors: 2, investigate: 1, drift: 1 });
  });

  it("counts the Drift tab's two pages apart: a new earnings setup is not a new down-drift setup", async () => {
    await pg.query(`INSERT INTO earnings_scans (created_at, version, symbol, report_date, reaction_date, timing, setup, numbers) VALUES
      ('2026-11-16T03:00:00Z', 'v', 'DELL', '2026-11-15', '2026-11-16', 'amc', 'A', '{}'),
      ('2026-11-16T03:00:00Z', 'v', 'HPQ', '2026-11-15', '2026-11-16', 'amc', NULL, '{}'),
      ('2026-11-10T03:00:00Z', 'v', 'OLD', '2026-11-09', '2026-11-10', 'amc', 'B', '{}')`);
    const since = "2026-11-15T00:00:00Z";
    const c = await badgeCounts({ drift: since, earnings: since }, new Date("2026-11-16T12:00:00Z"));
    // One down-drift setup first listed since (from the test above) and one earnings setup: each on its own page.
    expect(c).toEqual({ drift: 1, earnings: 1 });
    expect(await badgeCounts({ drift: "2026-11-16T10:00:00Z" }, new Date("2026-11-16T12:00:00Z"))).toEqual({ drift: 0 });
  });
});
