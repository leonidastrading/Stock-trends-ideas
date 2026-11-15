import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { getInvestigation, investigationContext, parsePlan, parseReport, recordsText, runInvestigation, startInvestigation } from "@/lib/scout/investigate";
import type { CallModel } from "@/lib/scout/llm";
import { playerOf } from "@/lib/scout/scoreboard";
import { parseAwards, parseLda, parseScheduleB } from "@/lib/sources/records";

const planJson = { title: "FAA ground stop", summary: "A router install grounded flights", companies: [{ name: "L3Harris", ticker: "$lhx", role: "contractor installing the router" }, { name: "ASI", ticker: "", role: "AI vendor, private" }], officials: [{ name: "Sean Duffy", role: "Transportation Secretary" }], programs: ["$50B air traffic control rebuild"], lookups: { contract_keywords: ["air traffic control", "NextGen", "x", "extra one"], contract_recipients: ["L3HARRIS TECHNOLOGIES"], lobbying_clients: ["L3Harris Technologies"], pac_names: ["ASI PAC"], tickers: ["LHX", "bad!", "RTX"] }, questions: ["Who gets the $50B?"] };

describe("investigations: parsing", () => {
  it("cleans the plan: tickers, lookup limits, short phrases dropped", () => {
    const p = parsePlan(JSON.stringify(planJson));
    expect(p.companies.map((c) => c.ticker)).toEqual(["LHX", ""]);
    expect(p.lookups.contract_keywords).toEqual(["air traffic control", "NextGen", "extra one"]);
    expect(p.lookups.tickers).toEqual(["LHX", "RTX"]);
  });

  it("reads contract awards, lobbying filings and PAC payments", () => {
    const a = parseAwards({ results: [{ "Award ID": "693KA9-26-C-0001", "Recipient Name": "L3HARRIS TECHNOLOGIES, INC.", "Award Amount": 1_200_000_000, "Awarding Agency": "Department of Transportation", "Awarding Sub Agency": "Federal Aviation Administration", Description: "FAA TELECOMMUNICATIONS INFRASTRUCTURE", "Start Date": "2024-01-01", "End Date": "2030-12-31", generated_internal_id: "CONT_AWD_X" }] });
    expect(a[0]).toMatchObject({ recipient: "L3HARRIS TECHNOLOGIES, INC.", ticker: "LHX", amount: 1.2e9, subAgency: "Federal Aviation Administration", url: "https://www.usaspending.gov/award/CONT_AWD_X" });
    const l = parseLda({ results: [{ client: { name: "L3HARRIS TECHNOLOGIES" }, registrant: { name: "Acme Lobbying LLC" }, filing_year: 2026, filing_period_display: "3rd Quarter (Jul 1 - Sep 30)", income: 120000, expenses: null, lobbying_activities: [{ general_issue_code_display: "Aviation/Aircraft/Airlines", description: "FAA modernization funding", government_entities: [{ name: "Federal Aviation Administration (FAA)" }, { name: "SENATE" }] }], dt_posted: "2026-10-20T10:00:00", filing_document_url: "https://lda.senate.gov/filings/public/filing/abc/print/" }] });
    expect(l[0]).toMatchObject({ registrant: "Acme Lobbying LLC", amount: 120000, issues: ["Aviation/Aircraft/Airlines"], agencies: ["Federal Aviation Administration (FAA)", "SENATE"], posted: "2026-10-20" });
    const p = parseScheduleB("ASI PAC", "C00999999", { results: [{ recipient_name: "ALFONSO FOR CONGRESS", disbursement_amount: 5000, disbursement_date: "2026-03-31T00:00:00", disbursement_description: "CONTRIBUTION", candidate_name: "ALFONSO, MICHAEL" }] });
    expect(p[0]).toMatchObject({ recipient: "ALFONSO FOR CONGRESS", amount: 5000, date: "2026-03-31", candidate: "ALFONSO, MICHAEL", url: "https://www.fec.gov/data/disbursements/?committee_id=C00999999" });
  });

  it("the report keeps only real tickers and clamps confidence", () => {
    const r = parseReport(JSON.stringify({ headline: "h", what_happened: "w", money_trail: [{ finding: "f", status: "confirmed", source: "https://x" }], listed: [{ ticker: "lhx", direction: "long", why: "funding", catalyst: "budget vote", catalyst_date: "2026-12-15", confidence: 140 }, { ticker: "Private Co", direction: "none", why: "", catalyst: "", catalyst_date: "", confidence: 10 }], open_questions: [], bottom_line: "b" }));
    expect(r.listed).toEqual([{ ticker: "LHX", direction: "long", why: "funding", catalyst: "budget vote", catalyst_date: "2026-12-15", confidence: 100 }]);
    expect(playerOf("scout", "investigate: LHX #3 FAA ground stop")).toBe("scout_investigations");
  });
});

describe("investigations: end to end (PGlite, fake model and records)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("plans, pulls the records with their links, and writes a report that cites them", async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (url: string) => {
      hosts.push(new URL(url).host);
      if (url.includes("usaspending")) return Response.json({ results: [{ "Recipient Name": "L3HARRIS TECHNOLOGIES, INC.", "Award Amount": 1.2e9, "Awarding Agency": "Department of Transportation", Description: "FAA TELECOM", "Start Date": "2024-01-01", "End Date": "2030-12-31", generated_internal_id: "CONT_AWD_X" }] });
      if (url.includes("lda.senate.gov")) return Response.json({ results: [] });
      if (url.includes("/committees/")) return Response.json({ results: [{ committee_id: "C00999999", name: "ASI PAC", committee_type_full: "PAC - Qualified" }] });
      if (url.includes("schedule_b")) return Response.json({ results: [{ recipient_name: "ALFONSO FOR CONGRESS", disbursement_amount: 5000, disbursement_date: "2026-03-31", disbursement_description: "CONTRIBUTION" }] });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const seen: Record<string, string> = {};
    const callModel: CallModel = async ({ user, purpose }) => {
      seen[purpose!] = user;
      const text = purpose === "investigate_plan" ? JSON.stringify(planJson) : JSON.stringify({ headline: "The router, the AI vendor and the $50B ask", what_happened: "w", money_trail: [{ finding: "ASI PAC gave $5,000 to Alfonso for Congress on 2026-03-31", status: "confirmed", source: "https://www.fec.gov/data/disbursements/?committee_id=C00999999" }], listed: [{ ticker: "LHX", direction: "long", why: "prime FAA telecom contractor if Congress funds the rebuild", catalyst: "funding vote", catalyst_date: "", confidence: 45 }], open_questions: ["Who wins the integrator role?"], bottom_line: "b" });
      return { text, stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.02 };
    };
    const id = await startInvestigation("On Friday every plane in America was ordered to stay on the ground after an L3Harris router install...");
    await runInvestigation(id, { data: null, sources: [], callModel, now: new Date("2026-11-16T15:00:00Z"), env: {} as NodeJS.ProcessEnv, fetchImpl });
    const inv = (await getInvestigation(id))!;
    expect(inv.status).toBe("done");
    expect(inv.title).toBe("FAA ground stop");
    expect(inv.costUsd).toBeCloseTo(0.04);
    expect(new Set(hosts)).toEqual(new Set(["api.usaspending.gov", "lda.senate.gov", "api.open.fec.gov"]));
    expect(seen.investigate_report).toContain("L3HARRIS TECHNOLOGIES, INC. [LHX]: $1.20B from Department of Transportation");
    expect(seen.investigate_report).toContain("ASI PAC → ALFONSO FOR CONGRESS: $5,000, CONTRIBUTION (https://www.fec.gov/data/disbursements/?committee_id=C00999999)");
    expect(recordsText(inv.records!)).toContain('LOBBYING FILINGS, client "L3Harris Technologies" (none found)');
    const ctx = investigationContext(inv, inv.report!.listed[0]);
    expect(ctx).toContain("[confirmed] ASI PAC gave $5,000 to Alfonso for Congress");
    expect(ctx).toContain("The exposure to check: long LHX");
    const { reportText } = await import("@/lib/scout/investigate");
    const rt = reportText(inv);
    expect(rt).toMatch(/^Investigation #\d+ \(\d{4}-\d{2}-\d{2}\): The router, the AI vendor and the \$50B ask/);
    expect(rt).toContain("- long LHX (confidence 45): prime FAA telecom contractor");
    expect(rt).toContain("Open questions:\n- Who wins the integrator role?");
  });
});
