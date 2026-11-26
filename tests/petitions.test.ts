import { describe, expect, it } from "vitest";
import { docRows, matchSymbols, petitionFrom, regsKey } from "@/lib/sources/regulations";
import { petitionLine } from "@/lib/scout/petitions";

describe("FDA citizen petitions (regulations.gov)", () => {
  it("a petition's state from its docket: final, interim, or none (and past the 180 days)", () => {
    const harmony = petitionFrom("FDA-2023-P-1273", [
      { title: "Citizen Petition from Pugsley Wood, LLP (on behalf of Scorpion Capital, LLC)", date: "2023-04-04" },
      { title: "Acknowledgment Letter from FDA DMS to Pugsley Wood, LLP (on behalf of Scorpion Capital, LLC)", date: "2023-04-04" },
      { title: "Interim Response Letter from FDA CDER to Pugsley Wood, LLP (on behalf of Scorpion Capital, LLC)", date: "2023-09-21" },
      { title: "Final Response Letter from FDA CDER to Pugsley Wood, LLP (on behalf of Scorpion Capital LLC)", date: "2024-06-24" },
    ], "Request that FDA take the following three actions described below: 1) Withdraw FDA approval of pitolisant", "2026-11-21")!;
    expect(harmony).toMatchObject({ petitioner: "Pugsley Wood, LLP for Scorpion Capital, LLC", status: "final response", statusDate: "2024-06-24", past180: false, shortSeller: true });
    const tmdx = petitionFrom("FDA-2025-P-0182", [{ title: "Citizen Petition from Scorpion Capital, LLC", date: "2025-01-16" }, { title: "Acknowledgment Letter from FDA DMB to Scorpion Capital, LLC", date: "2025-01-16" }], "Request that the FDA suspend Pre-Market Approval of TransMedics OCS devices", "2026-11-21")!;
    expect(tmdx).toMatchObject({ status: "no response yet", past180: true, daysOpen: 674 });
    expect(petitionLine(tmdx)).toContain("[no response yet; open 674 days, past the FDA's 180]");
    expect(petitionFrom("X", [{ title: "Comment from someone", date: "2025-01-01" }], null, "2026-01-01")).toBeNull();
  });

  it("matches petitions to stocks by company and drug names", () => {
    const names = [{ symbol: "TMDX", company: "TransMedics Group, Inc." }, { symbol: "SLNO", company: "Soleno Therapeutics Inc", drugs: ["VYKAT XR (diazoxide choline) extended-release tablets"] }, { symbol: "ABVX", company: "Abivax SA", drugs: ["obefazimod"] }, { symbol: "SE", company: "Sea Limited American Depositary Shares" }, { symbol: "AAL", company: "American Airlines Group Inc." }];
    expect(matchSymbols({ request: "Request that the FDA suspend Pre-Market Approval of TransMedics OCS devices", petitioner: "Scorpion Capital" }, names)).toEqual(["TMDX"]);
    expect(matchSymbols({ request: "Requests that the FDA voluntarily recall VYKAT XR from the US Market", petitioner: "Scorpion Capital LLC" }, names)).toEqual(["SLNO"]);
    expect(matchSymbols({ request: "Withdraw approval of an unrelated drug", petitioner: "Someone" }, names)).toEqual([]);
    // One word shared with a company's name is not a match (the mifepristone petition was linked to Sea, American Airlines and others).
    expect(matchSymbols({ request: "Restore the in-person dispensing requirement for mifepristone", petitioner: "American College of Pro-Life Obstetricians and Gynecologists" }, names)).toEqual([]);
  });

  it("rows link to the document; the key falls back to the FEC key, then the demo key", () => {
    expect(docRows([{ id: "FDA-2025-P-3314-0001", attributes: { title: "Citizen Petition from Scorpion Capital LLC", docketId: "FDA-2025-P-3314", documentType: "Other", agencyId: "FDA", postedDate: "2025-08-22T04:00:00Z" } }])).toEqual([{ date: "2025-08-22", title: "Citizen Petition from Scorpion Capital LLC", detail: "FDA-2025-P-3314 · Other · FDA", url: "https://www.regulations.gov/document/FDA-2025-P-3314-0001" }]);
    expect(regsKey({ FEC_API_KEY: "f" } as unknown as NodeJS.ProcessEnv)).toBe("f");
    expect(regsKey({ REGULATIONS_GOV_API_KEY: "r", FEC_API_KEY: "f" } as unknown as NodeJS.ProcessEnv)).toBe("r");
    expect(regsKey({} as NodeJS.ProcessEnv)).toBe("DEMO_KEY");
  });
});
