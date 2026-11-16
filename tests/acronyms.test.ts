import { describe, expect, it } from "vitest";
import { acronymPhrases, notTickers, phraseIsCompany } from "@/lib/scout/acronyms";

describe("product acronyms vs tickers", () => {
  it("finds acronyms spelled out in the text", () => {
    const m = acronymPhrases("DocuSign's Intelligent Agreement Management (IAM) platform. IAM ARR grew. The Department of Energy (DOE) said so.");
    expect(m.get("IAM")).toBe("Intelligent Agreement Management");
    expect(m.get("DOE")).toBe("Department of Energy");
  });

  it("keeps a real company spelled out with its ticker, drops a product that shares a ticker", () => {
    const names = { IAM: "Integrated Wellness Acquisition Corp", AMD: "Advanced Micro Devices, Inc.", TTD: "The Trade Desk, Inc." };
    const text = "Intelligent Agreement Management (IAM) is DocuSign's bet. Advanced Micro Devices (AMD) and The Trade Desk (TTD) are tickers. IAM ARR is 10% of revenue.";
    expect([...notTickers([text], names)]).toEqual(["IAM"]);
    expect(phraseIsCompany("Advanced Micro Devices", "Advanced Micro Devices, Inc.")).toBe(true);
    expect(phraseIsCompany("Intelligent Agreement Management", "Integrated Wellness Acquisition Corp")).toBe(false);
  });

  it("a stock the card is about is never dropped, and text without spelled-out acronyms changes nothing", () => {
    expect([...notTickers(["Intelligent Agreement Management (IAM)"], {}, ["IAM"])]).toEqual([]);
    expect([...notTickers(["NVDA and AMD rallied; IAM is unclear."], { NVDA: "NVIDIA Corp" })]).toEqual([]);
  });
});
