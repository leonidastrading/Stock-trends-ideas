import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { assessFilings, businessDaysBetween, deadlineDays, latestFilingWatch, rollWeekend, runFilingWatch, submissionRows, type FilingRow } from "@/lib/scout/filing-watch";

// NVIDIA's filings as EDGAR listed them on 2026-11-18: the 10-Q the same day as earnings for 12 reports, then not.
const PAIRS: Array<[string, string, string]> = [
  ["2026-08-26", "10-Q", "2026-07-26"], ["2026-05-20", "10-Q", "2026-04-26"], ["2026-02-25", "10-K", "2026-01-25"],
  ["2025-11-19", "10-Q", "2025-10-26"], ["2025-08-27", "10-Q", "2025-07-27"], ["2025-05-28", "10-Q", "2025-04-27"],
  ["2025-02-26", "10-K", "2025-01-26"], ["2024-11-20", "10-Q", "2024-10-27"], ["2024-08-28", "10-Q", "2024-07-28"],
];
const nvda = (): FilingRow[] => [
  { form: "8-K", filed: "2026-11-17", report: "2026-11-17", items: ["2.02", "9.01"], accession: "e-now" },
  { form: "13F-HR", filed: "2026-11-16", report: "2026-09-30", items: [], accession: "13f" },
  { form: "8-K", filed: "2026-11-12", report: "2026-11-10", items: ["5.02", "9.01"], accession: "502" },
  ...PAIRS.flatMap(([filed, form, report], i) => [
    { form, filed, report, items: [], accession: `p${i}` },
    { form: "8-K", filed, report: filed, items: ["2.02", "9.01"], accession: `e${i}` },
  ]),
];

describe("filing watch (pure)", () => {
  it("counts business days and rolls weekend deadlines", () => {
    expect(businessDaysBetween("2026-11-17", "2026-11-17")).toBe(0);
    expect(businessDaysBetween("2026-11-20", "2026-11-23")).toBe(1); // Friday to Monday
    expect(rollWeekend("2026-12-05")).toBe("2026-12-07");
    expect(deadlineDays("10-Q", "Large accelerated filer")).toEqual({ days: 40, size: "large accelerated filer" });
    expect(deadlineDays("10-K", "Accelerated filer")).toEqual({ days: 75, size: "accelerated filer" });
    expect(deadlineDays("10-Q", "Non-accelerated filer").days).toBe(45);
  });

  it("flags NVIDIA's missing 10-Q the day after earnings as later than usual", () => {
    const s = assessFilings("NVDA", nvda(), "Large accelerated filer", "2026-11-18")!;
    expect(s).toMatchObject({ status: "late_vs_usual", nextForm: "10-Q", periodEnd: "2026-10-25", dueBy: "2026-12-04", earnings8k: "2026-11-17" });
    expect(s.usualLags.every((x) => x === 0)).toBe(true);
    expect(s.message).toMatch(/NVDA has not filed its 10-Q for the quarter ended about Oct 25, 2026\. Earnings came out Nov 17, 2026.*the same day as earnings in each of its last 8 reports.*1 business day\. Due Dec 4, 2026 \(40 days after the period, large accelerated filer\)/);
    // On earnings day itself it is not late yet.
    expect(assessFilings("NVDA", nvda(), "Large accelerated filer", "2026-11-17")!.status).toBe("ok");
  });

  it("a late-filing notice, the deadline passing, and a 4.02 8-K each raise the status", () => {
    const nt = [{ form: "NT 10-Q", filed: "2026-12-07", report: "2026-10-25", items: [], accession: "nt" }, ...nvda()];
    const a = assessFilings("NVDA", nt, "Large accelerated filer", "2026-12-07")!;
    expect(a).toMatchObject({ status: "nt_filed", extendedTo: "2026-12-09" });
    expect(a.message).toMatch(/late-filing notice \(NT 10-Q, Form 12b-25\)/);
    expect(assessFilings("NVDA", nt, "Large accelerated filer", "2026-12-10")!.status).toBe("past_due");
    expect(assessFilings("NVDA", nvda(), "Large accelerated filer", "2026-12-07")!.status).toBe("past_due");
    const restated = [{ form: "8-K", filed: "2026-11-20", report: "2026-11-19", items: ["4.02"], accession: "402" }, ...nvda()];
    const r = assessFilings("NVDA", restated, "Large accelerated filer", "2026-11-21")!;
    expect(r.status).toBe("red_flag");
    expect(r.message).toMatch(/can no longer be relied on \(4\.02\) on Nov 20, 2026/);
  });

  it("is quiet once the 10-Q is filed, expects a 10-K after three 10-Qs, and skips companies that file no 10-Qs", () => {
    const filed = [{ form: "10-Q", filed: "2026-11-19", report: "2026-10-25", items: [], accession: "q3" }, ...nvda()];
    const s = assessFilings("NVDA", filed, "Large accelerated filer", "2026-11-20")!;
    expect(s).toMatchObject({ status: "ok", nextForm: "10-K" });
    expect(assessFilings("TSM", [{ form: "6-K", filed: "2026-11-10", report: null, items: [], accession: "x" }], null, "2026-11-18")).toBeNull();
  });

  it("reads a submissions document", () => {
    const rows = submissionRows({ category: "Large accelerated filer", filings: { recent: { accessionNumber: ["a"], filingDate: ["2026-11-17"], reportDate: ["2026-11-17"], form: ["8-K"], items: ["2.02,9.01"] } } });
    expect(rows).toEqual([{ form: "8-K", filed: "2026-11-17", report: "2026-11-17", items: ["2.02", "9.01"], accession: "a" }]);
  });
});

describe("filing watch end to end (PGlite, fake EDGAR)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("stores a change once, pushes it, and stays quiet while nothing changes", async () => {
    const rows = nvda();
    const doc = { category: "Large accelerated filer", filings: { recent: { accessionNumber: rows.map((r) => r.accession), filingDate: rows.map((r) => r.filed), reportDate: rows.map((r) => r.report ?? ""), form: rows.map((r) => r.form), items: rows.map((r) => r.items.join(",")) } } };
    const pushes: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("company_tickers")) return new Response(JSON.stringify({ 0: { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" } }));
      if (url.includes("CIK0001045810")) return new Response(JSON.stringify(doc));
      if (url.includes("ntfy")) { pushes.push(String(init?.body)); return new Response("{}"); }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const env = { NTFY_TOPIC: "t", DASHBOARD_URL: "https://x" } as unknown as NodeJS.ProcessEnv;
    const now = new Date("2026-11-18T15:00:00Z");
    expect(await runFilingWatch({ now, ua: "test agent", env, fetchImpl }, Date.now() + 10_000, ["NVDA"])).toMatch(/1 checked, 1 changed \(NVDA late_vs_usual\)/);
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(pushes[0]).title).toBe("NVDA: report later than usual");
    expect(await runFilingWatch({ now, ua: "test agent", env, fetchImpl }, Date.now() + 10_000, ["NVDA"])).toBe("1 checked");
    expect(pushes).toHaveLength(1);
    const w = (await latestFilingWatch(["NVDA"])).get("NVDA")!;
    expect(w).toMatchObject({ status: "late_vs_usual", cik: "1045810" });
  });
});
