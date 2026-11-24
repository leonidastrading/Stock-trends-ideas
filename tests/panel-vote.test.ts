import { describe, expect, it } from "vitest";
import { latestPanelVote, panelVoteLabel, panelVotesIn } from "../lib/sources/panel-vote";

const one = (t: string) => panelVotesIn(t)[0];
const A = "The Psychopharmacologic Drugs Advisory Committee of the FDA";

describe("reading a panel vote from a filing (sentences from real 8-Ks and 10-Qs)", () => {
  it("reads a plain count in favour", () => {
    expect(one(`${A} voted 12 to 5 in favor of approving Probuphine, the first long-acting implant.`)).toMatchObject({ side: "positive", yes: 12, no: 5 });
    expect(one("FDA Advisory Committee Votes 14 to 1, with 1 Abstention, in Favor of Approval")).toMatchObject({ side: "positive", yes: 14, no: 1 });
    expect(one("the Endocrinologic and Metabolic Drugs Advisory Committee voted unanimously (16-0) to recommend approval of an indication and label expansion for Vascepa.")).toMatchObject({ side: "positive", yes: 16, no: 0 });
    expect(one("The Advisory Committee voted 15 (yes) to 0 (no).")).toMatchObject({ side: "positive", yes: 15, no: 0 });
    expect(one("the Advisory Committee voted favorably (11 yes, 5 no) that the data support that arimoclomol is effective")).toMatchObject({ side: "positive", yes: 11, no: 5 });
  });
  it("reads a count against, whichever way round it is written", () => {
    expect(one("The committee voted 9-4 that the current benefits of poziotinib did not outweigh its risks.")).toMatchObject({ side: "negative", yes: 4, no: 9 });
    expect(one("The advisory committee voted 16 to 0 that the Company had not provided sufficient evidence to conclude that omburtamab improves overall survival.")).toMatchObject({ side: "negative", yes: 0, no: 16 });
    expect(one("the Cardiovascular and Renal Drugs Advisory Committee (CRDAC) voted 8 to 3 that the benefits of omecamtiv mecarbil do not outweigh its risks for the treatment of heart failure.")).toMatchObject({ side: "negative", yes: 3, no: 8 });
    expect(one("the Bone, Reproductive and Urologic Drugs Advisory Committee of the FDA voted six in favor and thirteen against the benefit/risk profile of TLANDO.")).toMatchObject({ side: "negative", yes: 6, no: 13 });
    expect(one("the Anesthetic and Analgesic Drug Products Advisory Committee voted 8 against, and 7 in favor of, the approval of oliceridine.")).toMatchObject({ side: "negative", yes: 7, no: 8 });
    expect(one("The advisory committee jointly voted that the benefit-risk profile was not adequate to support approval (Vote: 2 Yes, 21 No).")).toMatchObject({ side: "negative" });
    expect(panelVotesIn("The advisory committee jointly voted that the benefit-risk profile was not adequate to support approval (Vote: 2 Yes, 21 No).").some((v) => v.yes === 2 && v.no === 21)).toBe(true);
  });
  it("reads a vote with no count from its wording", () => {
    expect(one("the Cardiovascular and Renal Drugs Advisory Committee voted to recommend not approving roxadustat for the treatment of anemia due to CKD.")).toMatchObject({ side: "negative", yes: null, no: null });
    expect(one("the Cellular, Tissue and Gene Therapies Advisory Committee voted that available evidence did not support the effectiveness of Deramiocel for the treatment of DMD.")).toMatchObject({ side: "negative" });
    expect(one("FDA Advisory Committee Votes in Favor of the Clinical Benefit/Risk Profile of Imetelstat")).toMatchObject({ side: "positive", yes: null });
  });
  it("is not turned round by 'the risks do not outweigh the benefits'", () => {
    expect(one("the advisory committee voted 10 to 3 that the risks do not outweigh the benefits of the product.")).toMatchObject({ side: "positive", yes: 10, no: 3 });
  });
  it("keeps the date the text gives, and calls a tie a split", () => {
    expect(one("On July 30, 2026, the Cellular, Tissue and Gene Therapies Advisory Committee voted 3 to 9 on whether the data support approval.")).toMatchObject({ side: "negative", yes: 3, no: 9, said: "2026-07-30" });
    expect(one("the advisory committee voted eight to eight on the question of whether the overall benefits of sotagliflozin outweighed the risks")).toMatchObject({ side: "split", yes: 8, no: 8 });
  });
  it("leaves out what is not a panel's vote", () => {
    for (const t of [
      "At the annual meeting, stockholders voted 12 to 5 on the advisory vote on executive compensation.",
      "There is a risk that the advisory committee will vote against approval of POSIMIR or make other unfavorable votes.",
      "Conference call today at 8:30 a.m. The advisory committee meeting materials are posted.",
      "The board of directors voted 7 to 2 to form an advisory committee.",
      "The committee voted on three questions regarding the use of the test.",
    ]) expect(panelVotesIn(t), t).toEqual([]);
  });
});

describe("the vote to show for a pending decision", () => {
  const filing = "In 2019, an advisory committee voted 12 to 2 in favor of our first product. Later, on July 30, 2026, the Cellular, Tissue and Gene Therapies Advisory Committee voted 3 to 9 that the data support approval of Deramiocel. We have other programs.";
  it("takes the latest dated vote, and ignores one from an older review", () => {
    expect(latestPanelVote(filing, "2025-06-01")).toMatchObject({ side: "negative", yes: 3, no: 9, said: "2026-07-30" });
    expect(latestPanelVote("On March 2, 2019, the advisory committee voted 12 to 2 in favor of approval.", "2025-06-01")).toBeNull();
    expect(latestPanelVote("No panel was held for this product.", "2025-06-01")).toBeNull();
  });
  it("calls it split when the same meeting's questions went both ways", () => {
    const t = "On May 6, 2026, the advisory committee voted 10 to 8 in favor of approval. On May 6, 2026, the advisory committee voted 12 to 6 that the safety data were not adequate.";
    expect(latestPanelVote(t, "2025-01-01")).toMatchObject({ side: "split" });
  });
  it("labels a vote in plain words", () => {
    expect(panelVoteLabel({ side: "negative", yes: 3, no: 9 })).toBe("3–9 against");
    expect(panelVoteLabel({ side: "positive", yes: 12, no: 5 })).toBe("12–5 in favour");
    expect(panelVoteLabel({ side: "negative", yes: null, no: null })).toBe("against (no count given)");
  });
});
