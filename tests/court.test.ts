import { describe, expect, it } from "vitest";
import { classActionCases, classActionTicker, entities, isoFromWords, itcNotice, itcParties, itcStage, rssItems } from "@/lib/sources/court";

const companies = [
  { ticker: "DUOL", title: "Duolingo, Inc." }, { ticker: "LEN", title: "LENNAR CORP /NEW/" }, { ticker: "OI", title: "O-I Glass, Inc. /DE/" },
  { ticker: "APP", title: "AppLovin Corp" }, { ticker: "BETR", title: "Better Home & Finance Holding Co" }, { ticker: "AAPL", title: "Apple Inc." },
  { ticker: "CTKB", title: "Cytek Biosciences, Inc." }, { ticker: "MRP", title: "Millrose Properties, Inc." },
];
const known = new Set(companies.map((c) => c.ticker));

describe("court: securities class actions from the law firms' releases", () => {
  it("finds the stock in each firm's way of writing it", () => {
    expect(classActionTicker("Kaplan Fox Alerts Investors: Lead Plaintiff Deadline for Duolingo, Inc. (NASDAQ: DUOL) is December 7, 2026", known)).toBe("DUOL");
    expect(classActionTicker("SueWallSt Reminds Shareholders of a Lead Plaintiff Deadline of January 11, 2027 in Lennar Corporation Lawsuit - LEN", known)).toBe("LEN");
    expect(classActionTicker("OI Shareholder Alert: December 28, 2026 Lead Plaintiff Deadline in O-I Glass, Inc. Securities Class Action", known)).toBe("OI");
    expect(classActionTicker("Robbins LLP Reminds APP Investors of the November 16, 2026 Lead Plaintiff Deadline", known)).toBe("APP");
    expect(classActionTicker("Some unrelated headline", known)).toBeNull();
    expect(isoFromWords("deadline is December 7, 2026")).toBe("2026-12-07");
  });

  it("folds a dozen firms' releases into one case per stock, with the deadline and the firms", () => {
    const at = (d: string) => `2026-11-${d}T15:00:00.000Z`;
    const cases = classActionCases([
      { at: at("19"), headline: "Kaplan Fox Alerts Investors: Lead Plaintiff Deadline for Duolingo, Inc. (NASDAQ: DUOL) is December 7, 2026 - The National Law Review", url: "u1", source: "The National Law Review" },
      { at: at("19"), headline: "SueWallSt Reminds Shareholders of a Lead Plaintiff Deadline of December 7, 2026 in Duolingo, Inc. Lawsuit - DUOL - PR Newswire", url: "u2", source: "PR Newswire" },
      { at: at("19"), headline: "SueWallSt Reminds Shareholders of a Lead Plaintiff Deadline of December 7, 2026 in Duolingo, Inc. Lawsuit - DUOL - PR Newswire", url: "u3", source: "PR Newswire" },
      { at: at("13"), headline: "Securities Fraud Lawsuit Filed Against Lennar Corporation: The Law Offices of Frank R. Cruz Outlines Lead Plaintiff Deadline - Business Wire", url: "u4", source: "Business Wire" },
      { at: at("12"), headline: "Best stocks to buy this week - Motley Fool", url: "u5", source: "Motley Fool" },
    ], companies);
    expect(cases.map((c) => [c.symbol, c.releases, c.deadline, c.firms])).toEqual([["DUOL", 2, "2026-12-07", ["Kaplan Fox", "SueWallSt"]], ["LEN", 1, null, ["Frank R. Cruz"]]]);
  });

  it("reads Google News RSS", () => {
    const xml = `<rss><channel><item><title>BETR Lead Plaintiff Deadline is November 20, 2026 - Robbins LLP Reminds Better Home &amp; Finance Investors - Morningstar</title><link>https://n/1</link><pubDate>Mon, 09 Nov 2026 14:00:00 GMT</pubDate><source url="x">Morningstar</source></item></channel></rss>`;
    const [r] = rssItems(xml);
    expect(r).toMatchObject({ at: "2026-11-09T14:00:00.000Z", source: "Morningstar", url: "https://n/1" });
    expect(classActionCases([r], companies)[0]).toMatchObject({ symbol: "BETR", deadline: "2026-11-20", firms: ["Robbins"] });
  });
});

describe("court: ITC Section 337 patent cases from the Federal Register", () => {
  const instituted = "(3) For the purpose of the investigation so instituted, the following are hereby named as parties upon which this notice of investigation shall be served: (a) The complainant is: Cytek Biosciences, Inc., 47215 Lakeview Blvd., Fremont, California 94538. (b) The respondents are the following entities alleged to be in violation of section 337, and are the parties upon which the complaint is to be served: Beckman Coulter, Inc., 250 South Kraemer Blvd., Brea, CA 92821. Beckman Coulter Biotechnology (Suzhou) Co., Ltd., Units 101, 201, Building 4, Suzhou, China (c) The Office of Unfair Import Investigations";
  const receipt = "Notice is hereby given that the U.S. International Trade Commission has received a complaint entitled Certain Streaming Devices and Components Thereof, DN 3950. The complaint names as a respondent: Apple. Inc. of Cupertino, CA; ASUSTek Computer Inc. of Taiwan; ASUS Computer International of Fremont, CA. The complainant requests that the Commission issue a limited exclusion order.";

  it("names the stage of each notice", () => {
    expect(itcStage("Certain Spectral Flow Cytometry Systems and Components Thereof; Notice of Institution of Investigation")).toBe("instituted");
    expect(itcStage("Notice of Receipt of Complaint; Solicitation of Comments Relating to the Public Interest")).toBe("complaint");
    expect(itcStage("Certain Smartwatches; Notice of the Commission's Final Determination Finding a Violation; Issuance of a Limited Exclusion Order")).toBe("exclusion order");
    expect(itcStage("Certain Batteries; Notice of a Commission Determination Not To Review an Initial Determination Terminating the Investigation Based on Settlement")).toBe("ended");
  });

  it("reads the complainant and respondents and matches listed companies", () => {
    expect(itcParties(instituted)).toEqual({ complainants: ["Cytek Biosciences, Inc."], respondents: ["Beckman Coulter, Inc.", "Beckman Coulter Biotechnology (Suzhou) Co., Ltd."] });
    expect(entities("Units 101 of Building 4")).toEqual([]);
    expect(itcParties(receipt).respondents).toContain("Apple Inc.");
    const match = (n: string) => ({ "cytek biosciences": "CTKB", apple: "AAPL" } as Record<string, string>)[n.toLowerCase().replace(/,?\s*(inc\.?|corp\.?|corporation)$/i, "").trim()] ?? null;
    const n = itcNotice({ title: "Notice of Receipt of Complaint; Solicitation of Comments Relating to the Public Interest", publication_date: "2026-11-13", html_url: "https://fr/2", abstract: "received a complaint entitled Certain Streaming Devices and Components Thereof, DN 3950;" }, receipt, match);
    expect(n).toMatchObject({ stage: "complaint", product: "Certain Streaming Devices and Components Thereof", investigation: "DN 3950", respondentTickers: ["AAPL"] });
    const m = itcNotice({ title: "Certain Spectral Flow Cytometry Systems and Components Thereof; Notice of Institution of Investigation", publication_date: "2026-11-16", html_url: "https://fr/1", docket_ids: ["Investigation No. 337-TA-1528"] }, instituted, match);
    expect(m).toMatchObject({ stage: "instituted", investigation: "337-TA-1528", complainantTickers: ["CTKB"], respondentTickers: [] });
  });
});
