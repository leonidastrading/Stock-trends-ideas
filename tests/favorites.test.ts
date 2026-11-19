import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import * as store from "@/lib/scout/store";

describe("favorites (PGlite)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("stars, lists newest first, ignores a second star, and unstars", async () => {
    await store.setFavorite(12, true);
    await new Promise((r) => setTimeout(r, 5));
    await store.setFavorite(40, true);
    await store.setFavorite(12, true);
    expect((await store.favorites()).map((f) => f.cardId)).toEqual([40, 12]);
    await store.setFavorite(40, false);
    expect((await store.favorites()).map((f) => f.cardId)).toEqual([12]);
  });
});
