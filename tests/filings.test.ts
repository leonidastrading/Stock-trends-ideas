import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { FILINGS, loadIndexes, pickSignals, processQueue } from "@/lib/scout/filings";
import * as store from "@/lib/scout/store";
import { headerUrl, indexUrl, isRoutine, parseForm4, parseFormIndex, parseHeader, seriousItems, WANTED_FORMS } from "@/lib/sources/filings";

// Shapes copied from EDGAR (checked from Vercel's network on 2026-11-14).
const IDX = `Description:           Daily Index of EDGAR Dissemination Feed by Form Type
Last Data Received:    Nov 13, 2026
Form Type   Company Name                                                  CIK
      Date Filed  File Name
---------------------------------------------------------------------------------------------------------------------------------------------
1-A POS          Doroni Aerospace, Inc.                                        1890225     20261113    edgar/data/1890225/0001683168-26-008661.txt
4                10x Genomics, Inc.                                            1770787     20261113    edgar/data/1770787/0001610717-26-000453.txt
4                Saxonov Serge                                                 1700001     20261113    edgar/data/1700001/0001610717-26-000453.txt
4                Small Bank Corp                                               1234567     20261113    edgar/data/1234567/0001234567-26-000010.txt
4/A              Someone                                                       7654321     20261113    edgar/data/7654321/0007654321-26-000001.txt
8-K              ACORN ENERGY, INC.                                            880984      20261113    edgar/data/880984/0000880984-26-000099.txt
SCHEDULE 13D     Coursera, Inc.                                                1651562     20261113    edgar/data/1651562/0001072613-26-000890.txt
SCHEDULE 13D/A   Other Co                                                      1111111     20261113    edgar/data/1111111/0001111111-26-000002.txt
`;

const form4 = (code: string, opts: { plan?: boolean; shares?: number; price?: number; after?: number; owner?: string; ownerCik?: string; symbol?: string } = {}) => `<SEC-DOCUMENT>
<XML>
<ownershipDocument>
  <issuer><issuerCik>0001234567</issuerCik><issuerName>Small Bank Corp</issuerName><issuerTradingSymbol>${opts.symbol ?? "SMBK"}</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerCik>${opts.ownerCik ?? "0001900001"}</rptOwnerCik><rptOwnerName>${opts.owner ?? "Doe Jane"}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>true</isDirector><isOfficer>false</isOfficer></reportingOwnerRelationship></reportingOwner>
  <aff10b5One>${opts.plan ? "true" : "false"}</aff10b5One>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-11-12</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares>
          <value>${opts.shares ?? 10000}</value>
        </transactionShares>
        <transactionPricePerShare><value>${opts.price ?? 20}</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>${code === "S" ? "D" : "A"}</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${opts.after ?? 60000}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
</XML>
</SEC-DOCUMENT>`;

const HDR_8K = `<html><body><pre>
CONFORMED SUBMISSION TYPE:	8-K
ITEM INFORMATION:		Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review
ITEM INFORMATION:		Changes in Registrant&#39;s Certifying Accountant
ITEM INFORMATION:		Financial Statements and Exhibits
FILER:
		COMPANY CONFORMED NAME:			ACORN ENERGY, INC.
		CENTRAL INDEX KEY:			0000880984
</pre></body></html>`;
const HDR_13D = `<pre>
CONFORMED SUBMISSION TYPE:	SCHEDULE 13D
SUBJECT COMPANY:
		COMPANY CONFORMED NAME:			Coursera, Inc.
		CENTRAL INDEX KEY:			0001651562
FILED BY:
		COMPANY CONFORMED NAME:			NEW ENTERPRISE ASSOCIATES 13 LP
		CENTRAL INDEX KEY:			0001452907
</pre>`;

describe("SEC filing parsers", () => {
  it("daily index: the wanted forms, one row per filing (a Form 4 is listed under issuer and owner)", () => {
    const e = parseFormIndex(IDX, WANTED_FORMS);
    expect(e.map((x) => x.form)).toEqual(["4", "4", "8-K", "SCHEDULE 13D"]);
    expect(e[0]).toMatchObject({ company: "10x Genomics, Inc.", cik: "1770787", filed: "2026-11-13", accession: "0001610717-26-000453" });
    expect(indexUrl("2026-11-13")).toBe("https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261113.idx");
    expect(headerUrl(e[3])).toBe("https://www.sec.gov/Archives/edgar/data/1651562/000107261326000890/0001072613-26-000890-index-headers.html");
  });

  it("Form 4: open-market purchases only, with size against holdings", () => {
    const b = parseForm4(form4("P"))!;
    expect(b).toMatchObject({ symbol: "SMBK", issuerCik: "1234567", owner: "Doe Jane", ownerCik: "1900001", role: "director", date: "2026-11-12", shares: 10000, price: 20, value: 200000, ownedAfter: 60000, pctIncrease: 20, plan10b5: false });
    expect(parseForm4(form4("S"))).toBeNull(); // a sale
    expect(parseForm4(form4("M"))).toBeNull(); // an option exercise
    expect(parseForm4(form4("P", { plan: true }))!.plan10b5).toBe(true);
    expect(parseForm4("no xml here")).toBeNull();
  });

  it("routine vs opportunistic (same calendar month in each of the three previous years)", () => {
    expect(isRoutine(["2025-11-10", "2024-11-08", "2023-11-14", "2022-11-01"], "2026-11-12")).toBe(true);
    expect(isRoutine(["2025-11-10", "2023-11-14"], "2026-11-12")).toBe(false);
    expect(isRoutine([], "2026-11-12")).toBeNull();
  });

  it("8-K items and 13D subject from the SEC header", () => {
    const h = parseHeader(HDR_8K);
    expect(h.form).toBe("8-K");
    expect(seriousItems(h.items).map((s) => s.item)).toEqual(["4.02", "4.01"]);
    expect(h.filer).toEqual({ name: "ACORN ENERGY, INC.", cik: "880984" });
    const d = parseHeader(HDR_13D);
    expect(d.subject).toEqual({ name: "Coursera, Inc.", cik: "1651562" });
    expect(d.filedBy?.name).toBe("NEW ENTERPRISE ASSOCIATES 13 LP");
  });
});

describe("signals", () => {
  const buy = (p: Partial<store.InsiderBuyRow>): store.InsiderBuyRow => ({ accession: Math.random().toString(), filed: "2026-11-13", issuerCik: "1", symbol: "SMBK", issuerName: "Small Bank Corp", owner: "A", ownerCik: "1", role: "director", txDate: "2026-11-12", shares: 1000, price: 20, value: 20000, ownedAfter: 10000, pctIncrease: 11, plan10b5: false, routine: false, ...p });
  it("restatements first; confirmed opportunistic buying by non-executives outranks a 13D; routine buys ignored", () => {
    const s = pickSignals(
      [buy({ owner: "A" }), buy({ owner: "B" }), buy({ symbol: "BIG", owner: "C", value: 500000, pctIncrease: 25 }), buy({ symbol: "RTN", owner: "D", value: 900000, pctIncrease: 50, routine: true }), buy({ symbol: "OLD", owner: "E", value: 900000, pctIncrease: 50, filed: "2026-10-30" })],
      [{ accession: "x", kind: "8-K", filed: "2026-11-13", cik: "880984", symbol: "ACFN", company: "ACORN ENERGY", items: ["4.02 non-reliance on past financial statements", "4.01 auditor change"], filer: null },
       { accession: "y", kind: "13D", filed: "2026-11-13", cik: "1651562", symbol: "COUR", company: "Coursera, Inc.", items: [], filer: "NEW ENTERPRISE ASSOCIATES 13 LP" },
       { accession: "z", kind: "8-K", filed: "2026-11-13", cik: "9", symbol: "XYZ", company: "XYZ", items: ["5.02 director or officer departure"], filer: null }],
      "2026-11-14",
    );
    expect(s.map((x) => [x.kind, x.symbol, x.direction])).toEqual([["8-K", "ACFN", "short"], ["insider", "SMBK", "long"], ["13D", "COUR", "long"], ["insider", "BIG", "long"]]);
    expect(s[1].context).toMatch(/2 insider\(s\).*non-executive insider.*Cohen, Malloy & Pomorski.*local, non-executive insiders.*Lopez-Lira & Tang.*near 180 days/s);
    expect(s[0].term).toBe("filing: ACFN 8-K 4.02");
  });
});

describe("the filings desk end to end (PGlite, fake EDGAR)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("loads the index, reads each filing once, stores buys and alerts, and leaves the rest for the next call", async () => {
    const calls: string[] = [];
    const sec = (async (url: string) => {
      calls.push(url);
      if (url.includes("daily-index") && url.includes("20261113")) return new Response(IDX);
      if (url.includes("daily-index")) return new Response("Not Found", { status: 404 });
      if (url.includes("company_tickers")) return new Response(JSON.stringify({ 0: { cik_str: 880984, ticker: "ACFN", title: "Acorn Energy" }, 1: { cik_str: 1651562, ticker: "COUR", title: "Coursera" } }));
      if (url.includes("data.sec.gov/submissions")) return new Response(JSON.stringify({ filings: { recent: { form: ["4", "4"], filingDate: ["2025-03-01", "2024-07-01"] } } }));
      if (url.includes("0001610717-26-000453.txt")) return new Response(form4("S", { symbol: "TXG" }));
      if (url.includes("0001234567-26-000010.txt")) return new Response(form4("P"));
      if (url.includes("880984") && url.includes("index-headers")) return new Response(HDR_8K);
      if (url.includes("1651562") && url.includes("index-headers")) return new Response(HDR_13D);
      return new Response("?", { status: 500 });
    }) as unknown as typeof fetch;
    const now = new Date("2026-11-16T15:00:00Z"); // Monday: the previous business day is Friday Nov 13
    const idx = await loadIndexes(now, "Test test@example.com", sec);
    expect(idx).toMatchObject({ loaded: ["2026-11-13"], queued: 4 });
    expect((await loadIndexes(now, "Test test@example.com", sec)).queued).toBe(0); // not read twice
    const r = await processQueue(Date.now() + 60_000, "Test test@example.com", sec);
    expect(r).toMatchObject({ read: 4, buys: 1, alerts: 2, errors: 0 });
    const buys = await store.insiderBuysSince("2026-11-01");
    expect(buys).toEqual([expect.objectContaining({ symbol: "SMBK", value: 200000, routine: false })]);
    const alerts = await store.filingAlertsSince("2026-11-01");
    expect(alerts.map((a) => [a.kind, a.symbol])).toEqual(expect.arrayContaining([["13D", "COUR"], ["8-K", "ACFN"]]));
    expect((await store.secQueueStatus())).toMatchObject({ pending: 0, done: 4 });
    expect(FILINGS.maxResearchPerDay).toBe(4);
    const stopped = await processQueue(Date.now() - 1, "Test test@example.com", sec);
    expect(stopped.read).toBe(0);
  });
});

describe("who is buying (Cohen, Malloy & Pomorski: local, non-executive insiders)", async () => {
  const { insiderLine, insiderStrength } = await import("@/lib/scout/filings");
  const { isExecutive, issuerAddress } = await import("@/lib/sources/filings");
  const header = (state: string, street: string) => `<SEC-HEADER>\nREPORTING-OWNER:\n\tOWNER DATA:\n\t\tCOMPANY CONFORMED NAME:\tDoe Jane\n\tMAIL ADDRESS:\n\t\tSTREET 1:\t\tC/O SMALL BANK\n\t\tSTATE:\t\t\tNY\nISSUER:\n\tCOMPANY DATA:\n\t\tCOMPANY CONFORMED NAME:\tSmall Bank Corp\n\tBUSINESS ADDRESS:\n\t\tSTREET 1:\t\t${street}\n\t\tCITY:\t\t\tAKRON\n\t\tSTATE:\t\t\t${state}\n\tMAIL ADDRESS:\n\t\tSTATE:\t\t\tDE\n</SEC-HEADER>\n`;
  const withAddress = (xml: string, state: string, street: string) => xml.replace("</reportingOwnerId>", `</reportingOwnerId><reportingOwnerAddress><rptOwnerStreet1>${street}</rptOwnerStreet1><rptOwnerCity>X</rptOwnerCity><rptOwnerState>${state}</rptOwnerState></reportingOwnerAddress>`);

  it("tells top executives from other insiders", () => {
    expect(isExecutive("director, Chief Executive Officer")).toBe(true);
    expect(isExecutive("CFO")).toBe(true);
    expect(isExecutive("Chairman of the Board")).toBe(true);
    expect(isExecutive("director")).toBe(false);
    expect(isExecutive("10% owner")).toBe(false);
    expect(isExecutive("SVP, General Counsel")).toBe(false);
  });

  it("reads the company's home state from the SEC header and the insider's from the Form 4", () => {
    expect(issuerAddress(header("OH", "100 MAIN ST"))).toEqual({ state: "OH", street: "100 MAIN ST" });
    const local = parseForm4(header("OH", "100 MAIN ST") + withAddress(form4("P"), "OH", "12 Elm Road"))!;
    expect(local).toMatchObject({ ownerState: "OH", issuerState: "OH", local: true, executive: false });
    expect(parseForm4(header("OH", "100 MAIN ST") + withAddress(form4("P"), "FL", "1 Ocean Dr"))!.local).toBe(false);
    // Filed from the company's own address: says nothing about where the insider lives.
    expect(parseForm4(header("OH", "100 MAIN ST") + withAddress(form4("P"), "OH", "100 Main St., Suite 4"))!.local).toBeNull();
    expect(parseForm4(form4("P"))!.local).toBeNull();
  });

  it("ranks opportunistic, non-executive, local buying higher and says so to the research step", () => {
    const b = (o: Partial<import("@/lib/scout/store").InsiderBuyRow>) => ({ accession: "a", filed: "2026-11-10", issuerCik: null, symbol: "SMBK", issuerName: "Small Bank", owner: "Doe Jane", ownerCik: null, role: "director", txDate: "2026-11-09", shares: 10000, price: 20, value: 200000, ownedAfter: 60000, pctIncrease: 20, plan10b5: false, routine: false as boolean | null, ...o });
    const ceoUnknown = insiderStrength(1, [b({ role: "Chief Executive Officer", routine: null })]);
    const dirOpp = insiderStrength(1, [b({})]);
    const dirOppLocal = insiderStrength(1, [b({ local: true, ownerState: "OH", issuerState: "OH" })]);
    expect([ceoUnknown, dirOpp, dirOppLocal]).toEqual([1, 1.5, 1.8]);
    expect(insiderLine(b({ local: true, ownerState: "OH", issuerState: "OH" }))).toBe("Doe Jane (director) bought 10,000 shares at $20 = $200k on 2026-11-09, +20% to their holding; outside their usual trading month (opportunistic); non-executive insider; local: lives in OH, where the company is based");
    expect(insiderLine(b({ role: "CEO", routine: null }))).toContain("no trading history to tell routine from opportunistic; top executive");
  });
});
