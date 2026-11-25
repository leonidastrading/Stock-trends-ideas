import { describe, expect, it } from "vitest";
import { letterLine, withSymbols } from "../lib/scout/fda-letters";
import { faultsOf, readLetter, verdictLabel, type FdaLetterRaw } from "../lib/sources/fda-letters";

const HEAD = "U.S. FOOD & DRUG\n\nADMINISTRATION\n\nBLA 761524\nCOMPLETE RESPONSE\n\nSummit Therapeutics Inc.\nAttention: Regulatory Affairs\n\nDear Dr. Smith:\n\nPlease refer to your biologics license application. We have completed our review of this application, as amended, and have determined that we cannot approve this application in its present form. We have described our reasons for this action below and, where possible, our recommendations to address these issues.\n\n";
const TAIL = "\n\nPRESCRIBING INFORMATION\n\nWe reserve comment on the proposed labeling until the application is otherwise adequate.\n\nCARTON AND CONTAINER LABELING\n\nSAFETY UPDATE\n\nWhen you respond to the above deficiencies, include a safety update. Describe in detail any significant changes or findings in the safety profile.\n\nOTHER\n\nWithin one year after the date of this letter, you are required to resubmit or take other actions.";
const letter = (over: Partial<FdaLetterRaw>, body: string): FdaLetterRaw => ({ letter_date: "11/13/2026", approval_status: "Unapproved", company_name: "Summit Therapeutics Inc.", application_number: ["BLA 761524"], letter_type: "COMPLETE RESPONSE", text: HEAD + body + TAIL, ...over });

describe("reading an FDA rejection letter (shapes from the real letters on openFDA)", () => {
  it("a letter that faults the clinical evidence", () => {
    const l = readLetter(letter({}, "CLINICAL/STATISTICAL\n\nSubstantial evidence of effectiveness is not established and the benefit-risk profile does not support approval.\n\n1. The applicability of the trial results to US patients is uncertain."))!;
    expect(l).toMatchObject({ date: "2026-11-13", company: "Summit Therapeutics Inc.", application: "BLA 761524", faults: ["clinical evidence"], verdict: "clinical" });
    expect(l.quote).toMatch(/^Substantial evidence of effectiveness is not established/);
    expect(l.key).toBe("BLA 761524|2026-11-13");
  });
  it("a letter that faults only how and where the drug is made", () => {
    const l = readLetter(letter({ company_name: "Elevar Therapeutics Inc.", application_number: ["NDA 216586"], letter_date: "07/09/2026" }, "PRODUCT QUALITY\n\n1. The drug substance specification is not adequate.\n\nFACILITY INSPECTIONS\n\nFollowing pre-license inspection of the manufacturing facility, FDA conveyed deficiencies to the representative of the facility. Satisfactory resolution of these deficiencies is required before this application may be approved."))!;
    expect(l.faults).toEqual(["product quality", "factory inspection"]);
    expect(l.verdict).toBe("fixable");
    expect(verdictLabel(l.verdict)).toMatch(/fixable in months/);
    expect(l.quote).toMatch(/^1\. The drug substance specification/);
  });
  it("takes NONCLINICAL for what it is, and studies short of a trial are neither a new trial nor a factory fix", () => {
    expect(faultsOf("NONCLINICAL/PRODUCT QUALITY")).toEqual(["animal or lab studies", "product quality"]);
    expect(faultsOf("CLINICAL/CLINICAL PHARMACOLOGY")).toEqual(["dosing studies", "clinical evidence"]);
    expect(faultsOf("CLINICAL PHARMACOLOGY")).toEqual(["dosing studies"]);
    expect(faultsOf("HUMAN FACTORS")).toEqual(["device or usability"]);
    expect(faultsOf("PRESCRIBING INFORMATION")).toEqual([]);
    expect(readLetter(letter({}, "NONCLINICAL\n\nThe carcinogenicity assessment is incomplete.\n\nCLINICAL PHARMACOLOGY\n\nThe dose has not been justified."))!.verdict).toBe("studies");
    // Clinical evidence outranks the rest: a letter with both needs the trial anyway.
    expect(readLetter(letter({}, "FACILITY INSPECTIONS\n\nDeficiencies were conveyed.\n\nCLINICAL\n\nThe data are not sufficient to support a favorable benefit-risk assessment."))!.verdict).toBe("clinical");
  });
  it("does not count the letter's standing sections, and says so when it cannot read the reasons", () => {
    // Safety update, labeling and "other" are in every letter.
    const none = readLetter(letter({}, "We have the following comments on your application, which are described in the enclosure."))!;
    expect(none.faults).toEqual([]);
    expect(none.verdict).toBe("unclear");
    const cber = readLetter({ letter_date: "07/09/2025", company_name: "Capricor, Inc.", application_number: ["BL 125842"], text: "ADMINISTRATION\n\nJULY 9, 2025\n\nWe have completed our review of all the submissions you have made relating to this application.\n\nADDITIONAL COMMENTS\n\nNone." })!;
    expect(cber).toMatchObject({ date: "2025-07-09", verdict: "unclear", faults: [] });
    expect(readLetter({ letter_date: "soon", company_name: "X" })).toBeNull();
    expect(readLetter({ letter_date: "07/09/2025" })).toBeNull();
    expect(readLetter({ letter_date: "07/09/2025", company_name: "No Text Co" })).toMatchObject({ verdict: "unclear", quote: "" });
  });
});

describe("a letter with no headings is read from its wording", () => {
  it("a lack of substantial evidence is a clinical rejection, quoted from that sentence", () => {
    const l = readLetter(letter({ company_name: "Aldeyra Therapeutics, Inc." }, "1. There is a lack of substantial evidence consisting of adequate and well-controlled investigations that the drug product will have the effect it purports to have."))!;
    expect(l).toMatchObject({ faults: ["clinical evidence"], verdict: "clinical" });
    expect(l.quote).toMatch(/There is a lack of substantial evidence/);
    const cber = readLetter({ letter_date: "02/07/2026", company_name: "REGENXBIO, Inc.", text: "Our review finds the following. The single-arm study does not provide substantial evidence of effectiveness for the proposed indication." })!;
    expect(cber.verdict).toBe("clinical");
    expect(cber.quote).toMatch(/^The single-arm study does not provide substantial evidence/);
  });
  it("a factory finding with no heading is a manufacturing rejection", () => {
    const l = readLetter(letter({}, "During a recent inspection of the manufacturing facility for this application, our field investigator conveyed deficiencies to the representative of the facility."))!;
    expect(l).toMatchObject({ faults: ["factory inspection"], verdict: "fixable" });
  });
});

describe("letters on the Pharma tab", () => {
  it("matches a letter to its ticker and writes it as one line", () => {
    const l = readLetter(letter({}, "CLINICAL/STATISTICAL\n\nSubstantial evidence of effectiveness is not established."))!;
    const [listed, foreign] = withSymbols([l, { ...l, key: "x", company: "Seikagaku Corporation" }], (c) => (c.startsWith("Summit") ? "SMMT" : null));
    expect(listed.symbol).toBe("SMMT");
    expect(foreign.symbol).toBeNull();
    expect(letterLine(listed)).toMatch(/^FDA rejection letter dated 2026-11-13 to Summit Therapeutics Inc\. \(BLA 761524\): the FDA wants more clinical evidence \(usually a new trial\) \[clinical evidence\]\. In its words: "Substantial evidence/);
  });
});
