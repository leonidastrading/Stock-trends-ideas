import { describe, expect, it } from "vitest";
import { callDigest, fiscalLabel, type CallTurn } from "../lib/sources/transcripts";

describe("which quarter to ask for (labels checked against Alpha Vantage on Nov 25, 2026)", () => {
  it("names the fiscal year by the calendar year it ends in", () => {
    expect(fiscalLabel("0131", "2026-11-24")).toBe("2027Q3"); // Ambarella, quarter to Oct 31, 2026
    expect(fiscalLabel("0131", "2026-11-18")).toBe("2027Q3"); // Nvidia, quarter to late October 2026
    expect(fiscalLabel("0131", "2026-08-26")).toBe("2027Q2"); // Nvidia, quarter to late July 2026
    expect(fiscalLabel("0630", "2026-10-28")).toBe("2027Q1"); // Microsoft, quarter to Sep 30, 2026
    expect(fiscalLabel("1231", "2026-11-05")).toBe("2026Q3"); // Lexicon, a calendar year
    expect(fiscalLabel("1231", "2027-02-10")).toBe("2026Q4");
    expect(fiscalLabel("0930", "2026-11-10")).toBe("2026Q4"); // Ashland, year to Sep 30, 2026
    expect(fiscalLabel("0131", "2026-03-10")).toBe("2026Q4"); // Ambarella's year to Jan 31, 2026
  });
  it("treats a year ending in the first days of a month as ending with the month before (52-week retailers)", () => {
    expect(fiscalLabel("0201", "2025-11-25")).toBe("2026Q3"); // Abercrombie: quarter to early November 2025
    expect(fiscalLabel("0103", "2026-10-20")).toBe("2026Q3");
  });
  it("gives nothing for a bad year end or date", () => {
    expect(fiscalLabel("", "2026-11-24")).toBeNull();
    expect(fiscalLabel("1331", "2026-11-24")).toBeNull();
    expect(fiscalLabel("1231", "soon")).toBeNull();
  });
});

describe("what the call adds to the press release", () => {
  const t = (speaker: string, title: string, content: string): CallTurn => ({ speaker, title, content });
  const turns: CallTurn[] = [
    t("Operator", "Operator", "Good day, and thank you for standing by. Welcome to the third quarter earnings conference call."),
    t("Louis Gerhardy", "Vice President, Investor Relations", "Today's call contains forward-looking statements that are subject to risks and uncertainties. We will discuss non-GAAP financial measures."),
    t("Fermi Wang", "Chief Executive Officer", "Revenue in the quarter was a record for the company at 108 million dollars. We are seeing memory supply constraints that will limit shipments into the first half of next year. Our team did a wonderful job this quarter."),
    t("John Young", "Chief Financial Officer", "For the fourth quarter, we expect revenue between 97 and 103 million dollars, below the prior quarter because of the supply shortage."),
    t("Operator", "Operator", "Our first question comes from Tore Svanberg."),
    t("Tore Svanberg", "Analyst, Stifel", "Thanks. Could you size how much revenue the memory shortage is costing you next quarter, and whether customers are double ordering to get ahead of it?"),
    t("Fermi Wang", "Chief Executive Officer", "It is roughly ten million dollars of demand we cannot ship. We do not see double ordering yet, but we are watching it closely."),
    t("Tore Svanberg", "Analyst, Stifel", "Great, thank you."),
    t("Quinn Bolton", "Analyst, Needham", "Can you comment on the reports of sale talks, and whether the board has received a proposal from any party?"),
    t("Fermi Wang", "Chief Executive Officer", "We do not comment on rumours or speculation about the company."),
  ];

  it("keeps management's forward-looking sentences and drops the boilerplate and the pleasantries", () => {
    const d = callDigest(turns)!;
    expect(d).toMatch(/Management, looking ahead:/);
    expect(d).toMatch(/Wang: We are seeing memory supply constraints/);
    expect(d).toMatch(/Young: For the fourth quarter, we expect revenue between 97 and 103 million/);
    expect(d).not.toMatch(/forward-looking statements/);
    expect(d).not.toMatch(/wonderful job/);
    expect(d).not.toMatch(/thank you for standing by/);
  });
  it("lists the analysts' real questions with how each answer began", () => {
    const d = callDigest(turns)!;
    expect(d).toMatch(/Analysts asked:/);
    expect(d).toMatch(/Q \(Tore Svanberg, Analyst, Stifel\): Thanks\. Could you size how much revenue the memory shortage/);
    expect(d).toMatch(/A \(Wang\): It is roughly ten million dollars/);
    expect(d).toMatch(/Q \(Quinn Bolton, Analyst, Needham\): Can you comment on the reports of sale talks/);
    expect(d).toMatch(/A \(Wang\): We do not comment on rumours/);
    expect(d).not.toMatch(/Great, thank you/);
  });
  it("gives nothing for an empty or operator-only transcript, and stays within its size", () => {
    expect(callDigest([])).toBeNull();
    expect(callDigest(turns.slice(0, 1))).toBeNull();
    const long = [...turns.slice(0, 2), ...Array.from({ length: 60 }, (_, i) => t("Fermi Wang", "Chief Executive Officer", `We expect demand in segment ${i} to stay strong through fiscal 2027 with improving margins and a growing backlog of orders.`)), ...turns.slice(5)];
    expect(callDigest(long)!.length).toBeLessThanOrEqual(8500);
  });
});
