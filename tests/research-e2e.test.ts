/** End to end on PGlite: research → card logged → gates → paper track → bars → scoring. No network, no real model. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyBar, MarketData, NewsItem } from "@/lib/alpaca";
import { query, setQuerierForTests } from "@/lib/db";
import type { CallModel } from "@/lib/scout/llm";
import { researchCandidate } from "@/lib/scout/research";
import { buildReport, ideaResult } from "@/lib/scout/scoring";
import * as store from "@/lib/scout/store";
import { groupBars, updateTracks } from "@/lib/scout/tracking";
import { toSwingIdea } from "@/lib/scout/swing";
import { digestCards } from "@/lib/scout/digest";
import type { Source } from "@/lib/sources";
import { sampleCard } from "./card.test";

let pg: PGlite;
const now = new Date("2026-11-10T12:00:00Z"); // a Tuesday, 07:00 ET

/** Daily bars: every symbol climbs 1%/day from a per-symbol start, Nov 9 – Nov 27 2026 weekdays. */
const DATES = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"];
const start = (s: string) => (s === "SPY" ? 600 : s === "XLI" ? 140 : 100 + (s.charCodeAt(0) % 7));
const drift = (s: string) => (s === "HUBB" ? 0.02 : s === "SPY" ? 0.003 : 0.005);
const barsFor = (symbols: readonly string[], from: string, to: string): DailyBar[] =>
  symbols.flatMap((symbol) => DATES.filter((d) => d >= from && d <= to).map((date, i) => {
    const o = start(symbol) * (1 + drift(symbol)) ** DATES.indexOf(date);
    return { symbol, date, o, h: o * 1.01, l: o * 0.99, c: o * 1.002, v: 1000 };
  }));
const news: NewsItem[] = Array.from({ length: 3 }, (_, i) => ({ id: i, ts: "2026-11-01T00:00:00Z", headline: "h", summary: "", symbols: ["HUBB"], source: "benzinga", url: "https://www.reuters.com/x" }));
const data: MarketData = {
  getDailyBars: async (symbols, from, to) => barsFor(symbols, from, to),
  getNews: async () => news,
  getCalendar: async () => [],
};
const source: Source = {
  id: "edgar", label: "EDGAR", about: "", configured: () => true,
  probe: async () => ({ source: "edgar", status: "ok", signals: [{ source: "edgar", metric: "filings_30d", value: 11, baseline: 3, changeVs12m: 2.67, asOf: "2026-11-10", note: "11 filings vs 3/month" }] }),
};
const replies: string[] = [];
const prompts: string[] = [];
const callModel: CallModel = async ({ user }) => {
  prompts.push(user);
  return { text: replies.shift() ?? JSON.stringify(sampleCard()), stopReason: "end_turn", modelServed: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 500 }, costUsd: 0.014 };
};
const deps = { data, sources: [source], callModel, now, env: {} as NodeJS.ProcessEnv };

beforeAll(() => {
  pg = new PGlite();
  setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
});
afterAll(() => setQuerierForTests(null));

describe("research → card → track", () => {
  it("logs a promoted card with the version, measured lateness and a paper track", async () => {
    const r = await researchCandidate({ origin: "scout", term: "transformer shortage", kindHint: "second_order", tickersHint: ["HUBB"], observation: null }, deps);
    expect(r.outcome).toBe("card");
    if (r.outcome !== "card") return;
    expect(r.card.status).toBe("promoted");
    expect(r.card.versionId).toBe(1);
    expect(r.card.card.lateness.news_stories_30d).toBe(3); // measured by code, not the model's 4
    expect(r.card.card.lateness.stock_move_30d_pct).toBeCloseTo(2, 0); // one day of 2% drift in the fake bars
    expect(prompts[0]).toMatch(/11 filings vs 3\/month/);
    const t = await store.getTrack(r.card.id);
    expect(t).toMatchObject({ symbol: "HUBB", sectorEtf: "XLI", cardDate: "2026-11-10", deadlineDate: "2027-01-29", entryDate: null }); // day after the 2027-01-28 catalyst
    expect((await store.spendOn("2026-11-10")).cost).toBeCloseTo(0.014);
    expect((await store.candidatesSince(1))[0]).toMatchObject({ outcome: "card", reason: "promoted", cardId: r.card.id });
  });

  it("cards are append-only", async () => {
    await expect(query(`UPDATE cards SET title = 'x' WHERE id = 1`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM cards WHERE id = 1`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM scout_versions`)).rejects.toThrow(/append-only/);
  });

  it("retries once on a bad reply, rejects with no evidence, and logs materiality failures without a track", async () => {
    replies.push("garbage", JSON.stringify(sampleCard({ evidence: [] })));
    const r = await researchCandidate({ origin: "scout", term: "nothing", kindHint: null, tickersHint: [], observation: null }, deps);
    expect(r.outcome).toBe("rejected");
    expect(r.candidate?.reason).toMatch(/no evidence/);
    expect((await store.spendOn("2026-11-10")).calls).toBe(3);

    const t = sampleCard().tickers[0];
    replies.push(JSON.stringify(sampleCard({ title: "Tiny line", tickers: [{ ...t, revenue_share_pct: 3 }] })));
    const r2 = await researchCandidate({ origin: "scout", term: "tiny", kindHint: null, tickersHint: [], observation: null }, deps);
    expect(r2.outcome === "card" && r2.card.status).toBe("not_promoted");
    expect(await store.getTrack(r2.outcome === "card" ? r2.card.id : 0)).toBeNull();
  });

  it("human observations are tagged, proposed to the watch-list, and the daily cap stops the scout", async () => {
    replies.push(JSON.stringify(sampleCard({ title: "Everyone at the course has it", origin: "scout" })));
    const r = await researchCandidate({ origin: "human", term: "course gadget", kindHint: "consumer", tickersHint: [], observation: "Everyone at the course has Y." }, deps);
    expect(r.outcome === "card" && r.card.origin).toBe("human");
    expect(r.outcome === "card" && r.card.card.origin).toBe("human");
    expect((await store.watchlist("proposed")).map((w) => w.term)).toContain("Everyone at the course has it");

    await store.saveSettings({ ...(await store.loadSettings()), dailyCapUsd: 0.01 });
    const capped = await researchCandidate({ origin: "scout", term: "late one", kindHint: null, tickersHint: [], observation: null }, deps);
    expect(capped.outcome).toBe("capped");
    expect(capped.outcome !== "card" && capped.reason).toMatch(/daily LLM cap/);
    await store.saveSettings({ ...(await store.loadSettings()), dailyCapUsd: 5 });
  });

  it("the tracker enters at the next open, exits by rule, and the report scores it", async () => {
    // Before the next session's bar exists: entry pending.
    let rep = await updateTracks(data, new Date("2026-11-10T22:00:00Z"));
    expect(rep.entered).toEqual([]);
    rep = await updateTracks(data, new Date("2026-11-12T22:00:00Z"));
    expect(rep.entered.sort()).toEqual([1, 3]);
    let t = (await store.getTrack(1))!;
    expect(t.entryDate).toBe("2026-11-11");
    expect(t.entryPrice).toBeCloseTo(start("HUBB") * 1.02 ** 2, 6);
    expect(t.spyEntry).toBeCloseTo(600 * 1.003 ** 2, 6);

    // Vadim marks the invalidation on Nov 18 (ET): exit at the Nov 19 open.
    await query(`INSERT INTO track_events (card_id, kind, at, detail) VALUES (1, 'invalidated', '2026-11-18T15:00:00Z', 'backlog fell')`);
    rep = await updateTracks(data, new Date("2026-11-20T22:00:00Z"));
    expect(rep.exited).toContain(1);
    t = (await store.getTrack(1))!;
    expect(t).toMatchObject({ exitDate: "2026-11-19", exitReason: "invalidated" });
    expect(t.maxDrawdownPct).toBeLessThanOrEqual(0);

    const cards = await store.allCards();
    const tracks = await store.allTracks();
    const bars = groupBars(await store.loadBars([...new Set([...tracks.flatMap((x) => [x.symbol, "SPY", x.sectorEtf]), "CAT", "GE"])], "2026-11-01", "2026-11-27"));
    const ideas = tracks.map((x) => ideaResult(cards.find((c) => c.id === x.cardId)!, x, bars)!).filter(Boolean);
    const closed = ideas.find((i) => i.cardId === 1)!;
    expect(closed.closed).toBe(true);
    expect(closed.ret).toBeCloseTo(1.02 ** 6 - 1, 4); // 6 sessions of 2% drift, open to open
    expect(closed.excess!).toBeGreaterThan(0);
    expect(closed.baseline.length).toBeGreaterThan(0);
    const report = buildReport(ideas, cards[0].createdAt, new Date("2026-11-27T00:00:00Z"));
    expect(report.byOrigin.scout.closed).toBe(1);
    expect(report.byOrigin.human.n).toBe(1);
    expect(report.byStatus.promoted.closed).toBe(1);
    expect(report.verdict.due).toBe(false);
    expect(report.baseline.percentileOfActual).not.toBeNull();
  });

  it("digest ranks promoted cards and the swing payload fits the swing log's schema", async () => {
    const cards = await store.cardsSince(3650);
    const top = digestCards(cards);
    expect(top.every((c) => c.status === "promoted")).toBe(true);
    const idea = toSwingIdea(top[0], 5000);
    expect(idea).toMatchObject({ ticker: "HUBB", side: "long", catalyst: "earnings", exitRule: "time", exitParam: 90, notional: 5000, speculative: false });
    expect(idea.thesis.length).toBeLessThanOrEqual(1000);
  });
});
