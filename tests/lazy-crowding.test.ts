import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { analystsFrom, coverageBand } from "@/lib/sources/coverage";
import { components, crowdingScore, priceParts, timing, trimSignal, type CrowdingParts } from "@/lib/scout/crowding";
import { cosine, customersNamed, diffParagraphs, extractSection, mechanicalDiff, parseDiffRead, pickPair, watchWords, wordShifts, worthReading, type SubmissionsDoc } from "@/lib/scout/filing-diff";
import { floatsFrom, formIndex, weekKey, weekOrder } from "@/lib/scout/filing-diff-run";
import { capexRaise, parseLinks, rankSuppliers } from "@/lib/scout/readthrough";
import { playerOf, splitBy, toRound } from "@/lib/scout/scoreboard";
import type { CallModel } from "@/lib/scout/llm";

const subs = (forms: Array<[string, string]>): SubmissionsDoc => ({ cik: "0000012345", name: "ACME CORP", filings: { recent: { accessionNumber: forms.map((_, i) => `0000012345-26-00000${i}`), filingDate: forms.map((f) => f[1]), form: forms.map((f) => f[0]), primaryDocument: forms.map((_, i) => `acme-${i}.htm`) } } });

describe("filing-change reader: pure parts", () => {
  it("picks the latest 10-K / 10-Q and the same form about a year earlier", () => {
    const p = pickPair(subs([["8-K", "2026-11-10"], ["10-Q", "2026-11-05"], ["10-Q", "2026-08-05"], ["10-K", "2026-02-20"], ["10-Q", "2025-11-04"], ["10-Q", "2025-08-06"]]))!;
    expect(p.latest).toMatchObject({ form: "10-Q", filed: "2026-11-05", url: "https://www.sec.gov/Archives/edgar/data/12345/000001234526000001/acme-1.htm" });
    expect(p.prior?.filed).toBe("2025-11-04");
    expect(pickPair(subs([["10-K", "2026-02-20"]]))!.prior).toBeNull();
    expect(pickPair(subs([["10-Q", "2026-11-05"]]), "2026-11-05")).toBeNull();
  });

  it("cuts out the real risk-factor section, not the table of contents", () => {
    const text = "Table of contents\nItem 1A. Risk Factors 12\nItem 1B. Unresolved Staff Comments 30\n...\nItem 1A. Risk Factors\nOur business depends on a few customers and we may lose them at any time for many reasons.\nWe face competition.\nItem 1B. Unresolved Staff Comments\nNone.";
    const s = extractSection(text, "risk", "10-K");
    expect(s).toContain("Our business depends on a few customers");
    expect(s).not.toContain("Unresolved");
  });

  it("diffs paragraphs ignoring changed numbers; similarity; watch words; customers", () => {
    const old = "We had revenue of $12.4 million in fiscal 2025 and we depend on our largest customers for most of it.\nOur supply of key components comes from a single supplier located in Taiwan and could be disrupted.";
    const neu = "We had revenue of $19.8 million in fiscal 2026 and we depend on our largest customers for most of it.\nWe received a subpoena from the Department of Justice relating to our pricing practices and are cooperating fully.";
    const d = diffParagraphs(old, neu);
    expect(d.added).toEqual(["We received a subpoena from the Department of Justice relating to our pricing practices and are cooperating fully."]);
    expect(d.removed).toEqual(["Our supply of key components comes from a single supplier located in Taiwan and could be disrupted."]);
    expect(cosine(old, old)).toBe(1);
    expect(cosine(old, neu)).toBeLessThan(1);
    expect(watchWords("capacity backlog capacity")).toMatchObject({ capacity: 6666.7, backlog: 3333.3 });
    expect(wordShifts({ capacity: 1, backlog: 2 }, { capacity: 4, backlog: 2 }).map((s) => s.word)).toEqual(["capacity"]);
    expect(customersNamed("Sales to Walmart Inc. accounted for 14% of our net sales in 2026, and Costco accounted for approximately 11% of revenue.")).toEqual(["Walmart Inc", "Costco"]);
  });

  it("only spends an AI call when something changed", () => {
    const same = "Item 1A. Risk Factors\nWe depend on a few customers for most of our revenue and could lose them for many reasons.\nItem 2. Properties";
    const m = mechanicalDiff(same, same, "10-K");
    expect(m.added).toEqual([]);
    expect(worthReading(m)).toBe(false);
    expect(parseDiffRead(JSON.stringify({ headline: "h", flag: "nonsense", findings: [], research: true, research_direction: "long", research_why: "w" })).flag).toBe("routine");
  });

  it("small-cap batch helpers: week key, daily form index, floats, a fixed weekly order", () => {
    expect(weekKey("2026-11-21")).toBe("2026-W47");
    expect(weekKey("2026-01-01")).toBe("2026-W01");
    const idx = "Form Type   Company Name   CIK   Date Filed   File Name\n----\n10-Q            ACME CORP                                                     12345       20261120    edgar/data/12345/0000012345-26-000001.txt\n8-K             OTHER INC                                                     999         20261120    edgar/data/999/x.txt\n10-K/A          ACME CORP                                                     12345       20261120    edgar/data/12345/y.txt";
    expect(formIndex(idx)).toEqual([{ form: "10-Q", company: "ACME CORP", cik: "12345", date: "2026-11-20" }]);
    expect([...floatsFrom([{ data: [{ cik: 1, val: 5e8, end: "2026-06-30" }] }, { data: [{ cik: 1, val: 4e8, end: "2025-06-30" }, { cik: 2, val: 3e9, end: "2025-12-31" }] }])]).toEqual([["1", 5e8], ["2", 3e9]]);
    const xs = ["a", "b", "c", "d"];
    expect(weekOrder(xs, (x) => x, "2026-W47")).toEqual(weekOrder(xs.slice().reverse(), (x) => x, "2026-W47"));
  });
});

describe("filing-change reader: end to end (PGlite, fake SEC and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("reads the new 10-K against last year's and stores the AI's read", async () => {
    const doc = (extra: string) => `<html><body><p>Item 1A. Risk Factors</p><p>We depend on a small number of customers for a large share of our revenue and the loss of any could hurt us.</p>${extra}<p>Item 1B. Unresolved Staff Comments</p><p>Item 7. Management's Discussion and Analysis</p><p>Demand for our products exceeded our manufacturing capacity during the year and lead times extended.</p><p>Item 7A. Quantitative</p></body></html>`;
    const fetchImpl = (async (url: string) => {
      if (url.includes("submissions/CIK0000012345.json")) return Response.json(subs([["10-K", "2026-11-10"], ["10-K", "2025-11-12"]]));
      if (url.endsWith("acme-0.htm")) return new Response(doc("<p>We are subject to an investigation by the Department of Justice concerning our pricing practices, which could result in fines.</p><p>We have entered into a long-term supply agreement that commits us to minimum purchases through 2029 at fixed prices.</p>"));
      if (url.endsWith("acme-1.htm")) return new Response(doc(""));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    let asked = "";
    const callModel: CallModel = async ({ user, purpose }) => {
      expect(purpose).toBe("filing_diff");
      asked = user;
      return { text: JSON.stringify({ headline: "A new DOJ pricing investigation", flag: "red_flag", findings: [{ type: "litigation", direction: "negative", quote: "We are subject to an investigation by the Department of Justice", why: "a new federal probe" }], research: true, research_direction: "short", research_why: "new probe" }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01 };
    };
    const { diffLatest, diffsFor, diffLine } = await import("@/lib/scout/filing-diff");
    const d = (await diffLatest("12345", "ACME", "card", { data: null, sources: [], callModel, now: new Date("2026-11-21T15:00:00Z"), env: { SEC_USER_AGENT: "Test test@example.com" } as unknown as NodeJS.ProcessEnv, fetchImpl }))!;
    expect(d.flag).toBe("red_flag");
    expect(d.added).toBe(2);
    expect(asked).toContain("RISK-FACTOR PARAGRAPHS ADDED:\n- We are subject to an investigation by the Department of Justice");
    expect((await diffsFor(["ACME"]))[0].read?.headline).toBe("A new DOJ pricing investigation");
    expect(diffLine(d)).toContain("red flag · A new DOJ pricing investigation");
    // Already read: nothing new the second time.
    expect(await diffLatest("12345", "ACME", "card", { data: null, sources: [], callModel, now: new Date(), env: { SEC_USER_AGENT: "Test test@example.com" } as unknown as NodeJS.ProcessEnv, fetchImpl })).toBeNull();
  });
});

describe("crowding score and stage", () => {
  const parts = (over: Partial<CrowdingParts>): CrowdingParts => ({ attention: null, news: null, search: null, extension: null, run: null, coverage: null, ...over });

  it("scales each part and needs two of them", () => {
    expect(crowdingScore(parts({ attention: { perHour: 5, baseline: 2, z: 1.5, days: 30, bullishShare: 0.7 } })).score).toBeNull();
    const quiet = crowdingScore(parts({ attention: { perHour: 1, baseline: 1, z: -0.5, days: 30, bullishShare: null }, news: { stories30d: 1, baseline30d: 2, ratio: 0.6 }, extension: { close: 10, sma200: 10.5, pctAbove: -4.8 } }));
    expect(quiet.stage).toBe(0);
    expect(timing(quiet.stage)).toBe("early");
    const mania = crowdingScore(parts({ attention: { perHour: 40, baseline: 4, z: 3.6, days: 60, bullishShare: 0.8 }, news: { stories30d: 30, baseline30d: 6, ratio: 4.8 }, extension: { close: 80, sma200: 45, pctAbove: 77.8 }, run: { move30: 48, move5: 9, offHigh20: -2 } }));
    expect(mania.stage).toBe(3);
    expect(mania.score!).toBeGreaterThan(80);
    const unwind = crowdingScore(parts({ attention: { perHour: 20, baseline: 5, z: 2, days: 60, bullishShare: 0.4 }, news: { stories30d: 20, baseline30d: 6, ratio: 3 }, extension: { close: 60, sma200: 40, pctAbove: 50 }, run: { move30: 5, move5: -8, offHigh20: -18 } }));
    expect(unwind.stage).toBe(4);
  });

  it("price ahead of news counts fully only when the news is no busier than usual", () => {
    expect(components(parts({ run: { move30: 50, move5: 0, offHigh20: 0 }, news: { stories30d: 2, baseline30d: 2, ratio: 1 } })).priceAheadOfNews).toBe(100);
    expect(components(parts({ run: { move30: 50, move5: 0, offHigh20: 0 }, news: { stories30d: 9, baseline30d: 2, ratio: 3 } })).priceAheadOfNews).toBe(50);
  });

  it("the paper trim / cover signal", () => {
    const hot = parts({ attention: { perHour: 30, baseline: 3, z: 3.4, days: 40, bullishShare: 0.9 }, run: { move30: 38, move5: 6, offHigh20: 0 } });
    expect(trimSignal(hot, "long")).toMatch(/^Trim signal \(paper\): Stocktwits attention 3\.4σ above its baseline during a \+38% move in 30 days/);
    expect(trimSignal(hot, "short")).toBeNull();
    expect(trimSignal(parts({ attention: { perHour: 30, baseline: 3, z: 3.4, days: 40, bullishShare: 0.2 }, run: { move30: -30, move5: -5, offHigh20: -30 } }), "short")).toMatch(/^Cover signal/);
    expect(trimSignal(parts({ attention: { perHour: 9, baseline: 3, z: 2.2, days: 40, bullishShare: 0.9 }, run: { move30: 38, move5: 6, offHigh20: 0 } }), "long")).toBeNull();
  });

  it("price parts from daily bars", () => {
    const bars = Array.from({ length: 210 }, (_, i) => { const d = new Date(Date.UTC(2026, 3, 1) + i * 86400_000).toISOString().slice(0, 10); const c = i < 180 ? 10 : 10 + (i - 179); return { symbol: "X", date: d, o: c, h: c, l: c, c, v: 1 }; });
    const p = priceParts(bars, bars.at(-1)!.date);
    expect(p.extension!.pctAbove).toBeGreaterThan(100);
    expect(p.run!.offHigh20).toBe(0);
    expect(p.run!.move30).toBeGreaterThan(100);
  });
});

describe("analyst coverage", () => {
  it("counts the latest month and bands it", () => {
    expect(analystsFrom([{ period: "2026-10-01", strongBuy: 1, buy: 1, hold: 1 }, { period: "2026-11-01", strongBuy: 2, buy: 3, hold: 4, sell: 1, strongSell: 0 }])).toEqual({ analysts: 10, period: "2026-11-01" });
    expect(analystsFrom([])).toBeNull();
    expect([coverageBand(0), coverageBand(3), coverageBand(4), coverageBand(10), coverageBand(11), coverageBand(null)]).toEqual(["low", "low", "moderate", "moderate", "high", null]);
  });
});

describe("supply-chain read-through", () => {
  it("spots a big customer's capex raise, not a cut", () => {
    expect(capexRaise("Microsoft raises fiscal 2027 capex guidance as AI demand surges", ["MSFT"])).toBe("MSFT");
    expect(capexRaise("Alphabet lifts capital expenditures forecast to $95 billion", ["GOOG"])).toBe("GOOGL");
    expect(capexRaise("Meta to spend more: capex plans raised again", ["META", "NVDA", "AVGO", "ANET", "VRT"])).toBe("META");
    expect(capexRaise("Amazon cuts capex plans for 2027", ["AMZN"])).toBeNull();
    expect(capexRaise("Microsoft beats on cloud revenue", ["MSFT"])).toBeNull();
    expect(capexRaise("Nvidia raises capex", ["NVDA"])).toBeNull();
  });

  it("cleans the supplier list and ranks the ones that have not moved", () => {
    const links = parseLinks("MSFT", JSON.stringify({ suppliers: [
      { ticker: "$vrt", name: "Vertiv", supplies: "power and cooling", evidence: "web", source_url: "https://x.com/a", confidence: 80 },
      { ticker: "MSFT", name: "self", supplies: "", evidence: "knowledge", source_url: "", confidence: 99 },
      { ticker: "AMZN", name: "another customer", supplies: "", evidence: "knowledge", source_url: "", confidence: 99 },
      { ticker: "Not A Ticker", name: "x", supplies: "", evidence: "knowledge", source_url: "", confidence: 50 },
      { ticker: "CLS", name: "Celestica", supplies: "servers", evidence: "10-K", source_url: "javascript:x", confidence: 75 },
      { ticker: "ANET", name: "Arista", supplies: "switches", evidence: "knowledge", source_url: "", confidence: 140 },
    ] }));
    expect(links.map((l) => l.supplier)).toEqual(["VRT", "CLS", "ANET"]);
    expect(links[1].url).toBeNull();
    expect(links[2].confidence).toBe(100);
    const ranked = rankSuppliers(links, new Map([["VRT", 1.2], ["CLS", -0.5], ["ANET", 6.1]]));
    expect(ranked.map((r) => r.supplier)).toEqual(["CLS", "VRT"]); // ANET already moved; filings evidence first
  });
});

describe("scoreboard: new players and splits", () => {
  it("filing-change and read-through cards are their own players; results split by a label", () => {
    expect(playerOf("scout", "filing change: ACME 10-Q 2026-11-05")).toBe("scout_filing_changes");
    expect(playerOf("scout", "readthrough: VRT after MSFT capex raise")).toBe("scout_readthrough");
    expect(playerOf("scout", "filing: ACME 8-K 4.02")).toBe("scout_filings");
    const base = { cardId: 1, symbol: "A", direction: "long" as const, kind: "event" as const, closed: true, excess: 0.05, excessSector: null } as unknown as Parameters<typeof toRound>[0];
    const rounds = [toRound({ ...base, cardId: 1, excess: 0.05 }, "you", null, false), toRound({ ...base, cardId: 2, excess: -0.02 }, "you", null, false), toRound({ ...base, cardId: 3, excess: 0.01 }, "you", null, false)];
    const rows = splitBy(rounds, (r) => (r.cardId === 3 ? "late" : "early"), ["early", "middle", "late"]);
    expect(rows).toEqual([{ key: "early", calls: 2, closed: 2, wins: 1, hitRate: 0.5, banked: 30, avg: 15 }, { key: "late", calls: 1, closed: 1, wins: 1, hitRate: 1, banked: 10, avg: 10 }]);
  });
});
