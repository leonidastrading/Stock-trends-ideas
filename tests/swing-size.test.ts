import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import * as store from "@/lib/scout/store";
import { sendToSwing } from "@/lib/scout/swing";

describe("Swing idea sizes", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("sends ideas at the Settings size, and speculative ones (confidence under 50) smaller", async () => {
    const sent: number[] = [];
    const fake = (async (_url: string, init?: RequestInit) => { sent.push(JSON.parse(init!.body as string).notional); return Response.json({ ok: true }); }) as typeof fetch;
    const env = { SWING_API_URL: "https://swing.example", SWING_API_USER: "u", SWING_API_PASSWORD: "p", SWING_NOTIONAL: "5000" } as unknown as NodeJS.ProcessEnv;
    const card = (confidence: number) => ({ id: 1, primaryTicker: "PANW", direction: "long", timeLimitDays: 30, title: "t", card: { confidence, title: "t", observation: "o", catalyst: { what: "FDA decision", date: "2026-12-01" }, why_not_priced: "w", invalidation: "i" } }) as unknown as store.StoredCard;
    await sendToSwing(card(70), env, fake);
    await sendToSwing(card(40), env, fake);
    expect(sent).toEqual([2000, 1000]); // defaults for a $100k paper account; SWING_NOTIONAL no longer decides
    await store.saveSettings({ ...(await store.loadSettings()), swingSize: 2500, swingSpeculativeSize: 500 });
    await sendToSwing(card(40), env, fake);
    expect(sent.at(-1)).toBe(500);
  });
});
