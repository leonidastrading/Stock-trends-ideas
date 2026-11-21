import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import * as store from "@/lib/scout/store";

// These tests call the cron routes at the real clock time: quiet hours would make them rest.
process.env.QUIET_HOURS = "off";

describe("story scans called too often", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    process.env.CRON_SECRET = "test-secret";
  });
  afterAll(() => {
    setQuerierForTests(null);
    delete process.env.CRON_SECRET;
  });

  it("a call within 45 minutes of the last scan does nothing and records nothing", async () => {
    const { GET } = await import("@/app/api/cron/stories/route");
    await store.startRun("stories"); // a scan that just started
    const before = (await store.recentRuns(10)).length;
    const res = await GET(new Request("https://scout.example/api/cron/stories", { headers: { authorization: "Bearer test-secret" } }));
    const body = await res.json();
    expect(body.status).toBe("throttled");
    expect(body.note).toMatch(/last story scan started 0 min ago; one per 45 min/);
    expect((await store.recentRuns(10)).length).toBe(before);
    const bad = await GET(new Request("https://scout.example/api/cron/stories", { headers: { authorization: "Bearer nope" } }));
    expect(bad.status).toBe(401);
  });
});

describe("housekeeping slices", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("with no time left, every slice is deferred instead of overrunning the function", async () => {
    const { maintenance } = await import("@/lib/scout/engine");
    const r = await maintenance(Date.now() - 1, new Date("2026-11-14T21:00:00Z"));
    expect(r).toMatchObject({ chatter: "later: not enough time", chatterBars: "later: not enough time", chatterSymbols: "later: not enough time" });
    expect(r.cardSymbols).toMatchObject({ checked: 0 });
  });
});
