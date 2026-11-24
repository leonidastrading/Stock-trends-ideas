/** A run's hard stop: research still going at the time limit is queued, and a slow step is left to the next pass. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData } from "@/lib/alpaca";
import { query, setQuerierForTests } from "@/lib/db";
import { CUT, DAILY_BUDGET, within } from "@/lib/scout/engine";
import type { CallModel } from "@/lib/scout/llm";
import { CUT_OFF, researchCandidate } from "@/lib/scout/research";
import { SITE_WATCH } from "@/lib/scout/site-watch";
import type { Source } from "@/lib/sources";
import { sampleCard } from "./card.test";

const now = new Date("2026-11-10T12:00:00Z");
const data: MarketData = { getDailyBars: async () => [], getNews: async () => [], getCalendar: async () => [] };
const source: Source = { id: "edgar", label: "EDGAR", about: "", configured: () => true, probe: async () => ({ source: "edgar", status: "ok", signals: [] }) };
const never: CallModel = () => new Promise(() => undefined);
const quick: CallModel = async () => ({ text: JSON.stringify(sampleCard()), stopReason: "end_turn", modelServed: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.001 });

beforeAll(() => {
  const pg = new PGlite();
  setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
});
afterAll(() => setQuerierForTests(null));

describe("the time budget of a pass", () => {
  it("leaves room to finish: nothing heavy starts late, and the hard stop is well inside 5 minutes", () => {
    expect(DAILY_BUDGET.hardStop).toBeLessThanOrEqual(270_000);
    expect(DAILY_BUDGET.finishBy).toBeLessThan(DAILY_BUDGET.hardStop);
    for (const by of [DAILY_BUDGET.measureBy, DAILY_BUDGET.researchBy, DAILY_BUDGET.storiesBy, DAILY_BUDGET.followupsBy]) expect(DAILY_BUDGET.finishBy - by).toBeGreaterThanOrEqual(120_000);
    expect(SITE_WATCH.budgetMs).toBeLessThanOrEqual(200_000);
  });

  it("gives a step's result when it is in time, and null when it is still going at the limit", async () => {
    expect(await within(Promise.resolve(7), Date.now() + 1000)).toEqual({ value: 7 });
    expect(await within(new Promise(() => undefined), Date.now() + 30)).toBeNull();
    expect(await within(new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 60)), Date.now() + 20)).toBeNull(); // a late failure is not left unhandled
    await new Promise((r) => setTimeout(r, 80));
    expect(CUT).toMatch(/next pass/);
  });
});

describe("research still going at the hard stop", () => {
  const input = { origin: "scout" as const, term: "slow idea", kindHint: "event" as const, tickersHint: ["HUBB"], observation: null };

  it("is queued and recorded as waiting, instead of holding the run past its limit", async () => {
    const t0 = Date.now();
    const r = await researchCandidate(input, { data, sources: [source], callModel: never, now, env: {} as NodeJS.ProcessEnv, finishBy: Date.now() + 150 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r).toMatchObject({ outcome: "capped", reason: CUT_OFF });
    const queued = await query(`SELECT kind, status, payload FROM catchup_queue`);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "research", status: "pending" });
    expect((queued[0].payload as { term: string }).term).toBe("slow idea");
  });

  it("is not cut when it comes from the queue (it would only be queued again), and not when it is in time", async () => {
    const fromQueue = await researchCandidate({ ...input, term: "queued idea", tickersHint: ["ETN"], queued: true }, { data, sources: [source], callModel: quick, now, env: {} as NodeJS.ProcessEnv, finishBy: Date.now() - 1 });
    expect(fromQueue.outcome).not.toBe("capped");
    const inTime = await researchCandidate({ ...input, term: "quick idea", tickersHint: ["PWR"] }, { data, sources: [source], callModel: quick, now, env: {} as NodeJS.ProcessEnv, finishBy: Date.now() + 60_000 });
    expect(inTime.outcome).not.toBe("capped");
    expect(await query(`SELECT 1 FROM catchup_queue`)).toHaveLength(1);
  });
});
