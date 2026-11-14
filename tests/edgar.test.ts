import { describe, expect, it } from "vitest";
import { edgar, filingActivity, revenueYoY, type Submissions } from "@/lib/sources/edgar";

const now = new Date("2026-11-14T12:00:00Z");
const subs: Submissions = {
  cik: "0001336920",
  filings: { recent: {
    accessionNumber: ["0001336920-26-000101", "0001336920-26-000090", "0001336920-26-000080", "0001336920-26-000050", "0001336920-25-000010", "0000000000-26-000001"],
    filingDate: ["2026-11-10", "2026-10-28", "2026-09-02", "2026-05-01", "2025-06-01", "2026-11-11"],
    form: ["8-K", "10-Q", "8-K", "10-Q", "10-K", "4"],
    items: ["1.01,9.01", "", "5.02", "", "", ""],
    primaryDocument: ["ldos-8k.htm", "ldos-10q.htm", "ldos-8k2.htm", "q.htm", "k.htm", "f4.xml"],
  } },
};
const concept = { units: { USD: [
  { end: "2026-09-30", val: 4_400_000_000, frame: "CY2026Q3", form: "10-Q" },
  { end: "2025-09-30", val: 4_000_000_000, frame: "CY2025Q3", form: "10-Q" },
  { end: "2025-12-31", val: 16_000_000_000, frame: "CY2025", form: "10-K" },
  { end: "2026-06-30", val: 4_300_000_000, frame: "CY2026Q2", form: "10-Q" },
] } };

describe("edgar via data.sec.gov", () => {
  it("counts recent filings against the 12-month pace and pulls out material 8-K events", () => {
    const a = filingActivity(subs, now);
    expect(a.last30).toBe(2); // the 8-K and the 10-Q; the Form 4 is ignored
    expect(a.monthly12).toBe(0.3); // 4 qualifying filings in 12 months (the 2025-06 10-K is older)
    expect(a.events.map((e) => [e.date, e.items])).toEqual([["2026-11-10", ["1.01"]], ["2026-09-02", ["5.02"]]]);
    expect(a.events[0].url).toBe("https://www.sec.gov/Archives/edgar/data/1336920/000133692026000101/ldos-8k.htm");
  });
  it("revenue against the same quarter a year earlier", () => {
    expect(revenueYoY(concept)).toMatchObject({ latest: { frame: "CY2026Q3", end: "2026-09-30" }, prior: { frame: "CY2025Q3" }, growthPct: 10 });
    expect(revenueYoY({ units: { USD: [{ end: "2026-09-30", val: 1, frame: "CY2026Q3" }] } })).toBeNull();
  });
  it("probe: declared User-Agent on every request, per-ticker signals, unknown tickers noted, never calls efts directly", async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, ua: new Headers(init?.headers).get("user-agent") });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("company_tickers.json")) return json({ 0: { cik_str: 1336920, ticker: "LDOS", title: "Leidos" }, 1: { cik_str: 1067983, ticker: "BRK-B", title: "Berkshire" } });
      if (url.includes("/submissions/CIK0001336920.json")) return json(subs);
      if (url.includes("/companyconcept/CIK0001336920/us-gaap/Revenues.json")) return json(concept);
      if (url.includes("/companyconcept/")) return new Response("{}", { status: 404 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const r = await edgar.probe({ term: "air traffic control", kind: "event", tickers: ["LDOS", "ZZZZ"], now, env: { SEC_USER_AGENT: "Test Person test@example.com" } as unknown as NodeJS.ProcessEnv, fetchImpl });
    expect(r.status).toBe("ok");
    expect(r.signals.map((s) => s.metric)).toEqual(["filings_30d:LDOS", "material_events_90d:LDOS", "revenue_yoy_pct:LDOS"]);
    expect(r.signals[0].note).toMatch(/8-K events in 90 days: 2026-11-10 material agreement/);
    expect(r.signals[2]).toMatchObject({ value: 10, asOf: "2026-09-30" });
    expect(r.detail).toMatch(/ZZZZ: not an SEC filer/);
    expect(seen.every((s) => s.ua === "Test Person test@example.com")).toBe(true);
    expect(seen.some((s) => s.url.includes("efts.sec.gov"))).toBe(false);
  });
  it("missing without a User-Agent", async () => {
    const r = await edgar.probe({ term: "x", kind: null, tickers: ["LDOS"], now, env: {} as NodeJS.ProcessEnv });
    expect(r.status).toBe("missing");
  });
});
