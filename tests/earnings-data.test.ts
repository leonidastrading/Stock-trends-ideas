import { describe, expect, it } from "vitest";
import { finnhubDates } from "@/lib/sources/earnings-data";
describe("Finnhub report dates (foreign companies)", () => {
  it("keeps this stock's past report dates, sorted, once each", () => {
    const j = { earningsCalendar: [{ symbol: "PDD", date: "2026-11-19" }, { symbol: "PDD", date: "2026-08-25" }, { symbol: "PDD", date: "2026-11-19" }, { symbol: "BABA", date: "2026-11-18" }, { symbol: "PDD", date: "2027-03-20" }, { symbol: "PDD", date: "" }] };
    expect(finnhubDates(j, "PDD", "2026-11-22")).toEqual(["2026-08-25", "2026-11-19"]);
  });
});

describe("revenue from a second source", () => {
  it("finds the report's row within three days and reads either feed's field names", async () => {
    const { revenueOf, revenueRow } = await import("@/lib/sources/earnings-data");
    const finnhub = [{ symbol: "BJ", date: "2026-08-21", revenueActual: 5.1e9, revenueEstimate: 5.0e9 }, { symbol: "BJ", date: "2026-11-20", revenueActual: 5.6e9, revenueEstimate: 5.4e9 }];
    expect(revenueOf(revenueRow(finnhub, "2026-11-20", "BJ"), "Finnhub")).toEqual({ revenueActual: 5.6e9, revenueEstimate: 5.4e9, source: "Finnhub" });
    // FMP: after-close reports are dated the day before; "revenueEstimated" and (older API) "revenue".
    const fmp = [{ symbol: "PDD", date: "2026-11-18", revenue: 1.08e11, revenueEstimated: 1.07e11 }, { symbol: "PDD", date: "2026-08-25", revenueActual: 1.0e11, revenueEstimated: 1.0e11 }];
    expect(revenueOf(revenueRow(fmp, "2026-11-19", "PDD"), "Financial Modeling Prep")).toMatchObject({ revenueActual: 1.08e11, revenueEstimate: 1.07e11 });
    expect(revenueRow(fmp, "2026-10-01", "PDD")).toBeNull();
    expect(revenueOf({ date: "2026-11-19", revenueActual: null, revenueEstimated: 0 }, "x")).toBeNull();
    expect(revenueRow("not a list", "2026-11-19")).toBeNull();
  });

  it("fills one source's gaps from the next and names both", async () => {
    const { mergeRevenue } = await import("@/lib/sources/earnings-data");
    expect(mergeRevenue([{ revenueActual: 5.6e9, revenueEstimate: null, source: "Finnhub" }, { revenueActual: 5.7e9, revenueEstimate: 5.4e9, source: "Financial Modeling Prep" }])).toEqual({ revenueActual: 5.6e9, revenueEstimate: 5.4e9, source: "Finnhub + Financial Modeling Prep" });
    expect(mergeRevenue([null, { revenueActual: 1, revenueEstimate: 2, source: "Financial Modeling Prep" }])?.source).toBe("Financial Modeling Prep");
    expect(mergeRevenue([null, null])).toBeNull();
  });

  it("asks Finnhub by symbol, then Financial Modeling Prep, and never throws", async () => {
    const { revenueFallback } = await import("@/lib/sources/earnings-data");
    const calls: string[] = [];
    const fake: typeof fetch = async (url) => {
      const u = String(url); calls.push(u.replace(/apikey=[^&]+/, "apikey=…"));
      if (u.includes("finnhub.io")) return new Response(JSON.stringify({ earningsCalendar: [{ symbol: "BJ", date: "2026-11-20", revenueActual: 5.6e9, revenueEstimate: null }] }), { status: 200 });
      if (u.includes("/stable/earnings")) return new Response("{}", { status: 402 });
      return new Response(JSON.stringify([{ symbol: "BJ", date: "2026-11-20", revenue: 5.6e9, revenueEstimated: 5.4e9 }]), { status: 200 });
    };
    const env = { FINNHUB_API_KEY: "f", FMP_API_KEY: "m" } as unknown as NodeJS.ProcessEnv;
    expect(await revenueFallback("BJ", "2026-11-20", env, fake)).toEqual({ revenueActual: 5.6e9, revenueEstimate: 5.4e9, source: "Finnhub + Financial Modeling Prep" });
    expect(calls.map((c) => new URL(c).hostname)).toEqual(["finnhub.io", "financialmodelingprep.com", "financialmodelingprep.com"]);
    expect(calls[0]).toContain("symbol=BJ");
    expect(await revenueFallback("BJ", "2026-11-20", {} as NodeJS.ProcessEnv, fake)).toBeNull();
    expect(await revenueFallback("BJ", "2026-11-20", env, async () => { throw new Error("offline"); })).toBeNull();
  });
});

describe("the earnings press release", () => {
  it("looks in the 8-K with item 2.02 first, then in 6-Ks nearest the report", async () => {
    const { releaseFilings } = await import("@/lib/sources/earnings-data");
    const us = { form: ["8-K", "8-K", "10-Q", "8-K"], filingDate: ["2026-11-20", "2026-11-20", "2026-11-21", "2026-08-21"], accessionNumber: ["a-1", "a-2", "a-3", "a-4"], items: ["5.02", "2.02,9.01", "", "2.02"] };
    expect(releaseFilings(us, "2026-11-20")).toEqual([{ accession: "a-2", form: "8-K" }]);
    // PDD on Nov 19, 2026: 6-Ks only; the one filed on the day comes first, the August one is out of range.
    const pdd = { form: ["6-K", "6-K", "6-K"], filingDate: ["2026-11-21", "2026-11-19", "2026-08-25"], accessionNumber: ["b-1", "b-2", "b-3"] };
    expect(releaseFilings(pdd, "2026-11-19")).toEqual([{ accession: "b-2", form: "6-K" }, { accession: "b-1", form: "6-K" }]);
  });

  it("tells a results release from other 6-K exhibits", async () => {
    const { looksLikeResults } = await import("@/lib/sources/earnings-data");
    expect(looksLikeResults("PDD Holdings Announces Third Quarter 2026 Unaudited Financial Results. Total revenues in the quarter were RMB108,276.5 million")).toBe(true);
    expect(looksLikeResults("Alibaba Group Announces Results of Annual General Meeting of shareholders")).toBe(false);
    expect(looksLikeResults("H World Group Limited Announces Change of Director")).toBe(false);
  });
});
