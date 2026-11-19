import { describe, expect, it } from "vitest";
import { normName, parseFdaCalendar, parseWhen, sponsorMatcher, trialReadouts } from "@/lib/sources/pharma";

// Shape copied from rttnews.com/corpinfo/fdacalendar.aspx (read from Vercel's network on 2026-11-19).
const ROW = (company: string, links: string, drug: string, when: string, event: string, outcome: string, status: string, id: number) => `<div class="grid-row border-bottom pt-1 pb-1"> <div data-th="Company Name" data-group="calData" class="tblcontent1">${company} <br /> ( ${links} ) </div> <div data-th="Drug" data-group="calData" class="tblcontent2">${drug}</div> <div data-th="Event" data-group="calData" class="tblcontent3"><span class="bg-purple"> ${when}</span> <br /> ${event}</div> <div data-th="Outcome" data-group="calData" class="tblcontent4"><span id="ctl00_CPI_rptFDACalendar_ctl01_lblOutcome">${outcome}</span><span class="transparent">-</span></div> <div data-th="Details" data-group="calData" class="tblcontent5"> <input type="hidden" name="x" id="ctl00_CPI_rptFDACalendar_ctl01_hdnDrugStatus" value="${status} " /> <a id="y" class="lnkDetails" href="FDADetail.aspx?ID=${id}"><i class="bi bi-capsule-pill fs-5"></i> Drug Status</a></div></div>`;
const PAGE = `<html><body>${ROW("Roche Holding AG", '<a href="https://www.rttnews.com/companies/9332/roche-holding-ag-rhhby">RHHBY</a>, RO.SW, ROG.SW', "Gazyva/Gazyvaro (sBLA)", "Nov 2026", "FDA decision on Gazyva/Gazyvaro for the treatment of primary membranous nephropathy", "Pending", "Priority Review", 2650)}
${ROW("Praxis Precision Medicines Inc.", '<a href="https://www.rttnews.com/companies/1/praxis-prax">PRAX</a>', "Relutrigine (NDA)", "12/27/2026", "FDA decision on relutrigine for SCN2A/SCN8A developmental and epileptic encephalopathies", "Pending", "Standard Review", 2700)}</body></html>`;

describe("FDA calendar", () => {
  it("reads company, ticker, drug, date, decision, review status and link", () => {
    const rows = parseFdaCalendar(PAGE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ company: "Roche Holding AG", symbol: "RHHBY", otherSymbols: ["RO.SW", "ROG.SW"], drug: "Gazyva/Gazyvaro (sBLA)", when: "Nov 2026", date: null, month: "2026-11", outcome: "Pending", status: "Priority Review", detailUrl: "https://www.rttnews.com/corpinfo/FDADetail.aspx?ID=2650" });
    expect(rows[0].event).toBe("FDA decision on Gazyva/Gazyvaro for the treatment of primary membranous nephropathy");
    expect(rows[1]).toMatchObject({ symbol: "PRAX", date: "2026-12-27", month: "2026-12", note: "" });
    const long = parseFdaCalendar(PAGE.replace("Standard Review", "In April 2026, the FDA extended the review period by three months to November 22, 2026"))[1];
    expect(long).toMatchObject({ status: "", note: "In April 2026, the FDA extended the review period by three months to November 22, 2026" });
  });

  it("reads exact, month, quarter and half-year dates", () => {
    expect(parseWhen("02/28/2027")).toEqual({ date: "2027-02-28", month: "2027-02" });
    expect(parseWhen("Feb 2027")).toEqual({ date: null, month: "2027-02" });
    expect(parseWhen("Q4 2026")).toEqual({ date: null, month: "2026-12" });
    expect(parseWhen("1H 2027")).toEqual({ date: null, month: "2027-06" });
  });
});

describe("Phase 3 readouts", () => {
  const companies = [
    { ticker: "VRTX", title: "VERTEX PHARMACEUTICALS INC / MA" }, { ticker: "PRAX", title: "Praxis Precision Medicines, Inc." },
    { ticker: "ARCT", title: "Arcturus Therapeutics Holdings Inc." }, { ticker: "OCS", title: "Oculis Holding AG" },
    { ticker: "ABCD", title: "Apex Bio Inc" }, { ticker: "ABCE", title: "Apex Therapeutics Corp" }, { ticker: "VRTX-W", title: "Vertex warrants" },
  ];
  const match = sponsorMatcher(companies);

  it("matches sponsors to US tickers by name, and leaves ambiguous or unknown names out", () => {
    expect(normName("Praxis Precision Medicines, Inc.")).toBe("praxis precision medicines");
    expect(match("Praxis Precision Medicines")).toBe("PRAX");
    expect(match("Oculis")).toBe("OCS");
    expect(match("Arcturus Therapeutics, Inc.")).toBe("ARCT");
    expect(match("Apex")).toBeNull(); // two registrants reduce to "apex"
    expect(match("Octapharma")).toBeNull();
  });

  it("keeps US-listed sponsors' trials, soonest first, without placebo arms", () => {
    const study = (nct: string, sponsor: string, date: string, drugs: string[]) => ({ protocolSection: { identificationModule: { nctId: nct, briefTitle: `Trial ${nct}` }, statusModule: { primaryCompletionDateStruct: { date } }, sponsorCollaboratorsModule: { leadSponsor: { name: sponsor } }, conditionsModule: { conditions: ["Dry Eye Disease"] }, designModule: { phases: ["PHASE3"] }, armsInterventionsModule: { interventions: drugs.map((name) => ({ name })) } } });
    const out = trialReadouts([study("NCT2", "Oculis", "2026-12", ["licaminlimab", "Vehicle of licaminlimab"]), study("NCT1", "Octapharma", "2026-12-01", ["Atenativ"]), study("NCT3", "Praxis Precision Medicines", "2026-11-30", ["relutrigine", "Placebo"])], match);
    expect(out.map((t) => [t.nct, t.symbol, t.drugs])).toEqual([["NCT3", "PRAX", ["relutrigine"]], ["NCT2", "OCS", ["licaminlimab"]]]);
    expect(out[0].phase).toBe("Phase 3");
  });
});
