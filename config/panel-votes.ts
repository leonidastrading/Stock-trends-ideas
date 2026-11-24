/**
 * FDA advisory panel votes on drugs and devices of US-listed small and mid cap companies, 2019 to 2026, with the
 * FDA's decision that followed. The list behind the panel-vote study on the Pharma tab (lib/scout/panel-study.ts).
 *
 * How it was built (November 2026):
 * - A search of SEC EDGAR's full text for 8-Ks from drug and device companies reporting an advisory committee vote,
 *   each vote sentence read by code and then checked by eye. Most companies never file their panel's vote, so this
 *   alone found only about thirty since 2019.
 * - The well-known votes that search missed, each checked against the public record (company releases, the FDA,
 *   trade press); the link on each row is the source.
 * Left out: large drug makers (Incyte, Alnylam and bigger: one drug rarely moves them), tied votes, meetings with no
 *   vote on approval, votes on a drug already on the market, stocks that only traded over the counter or whose ticker
 *   was later reused (Mallinckrodt), and Capricor (CAPR: 3 for, 9 against on July 29, 2026; rejected November 20,
 *   2026): it is the case that prompted the test, so counting it would be marking our own homework.
 * A decision announced the same day as the vote (Nektar withdrew its application that evening) counts as an outcome
 *   but gives no trade to the decision.
 *
 * It is NOT complete: there is no free machine-readable list of panel votes. Treat the study as a small sample.
 * A row: the day the vote was public | ticker then | company | + for, - against | for | against | the day the
 * decision was announced | A approved, R rejected (a complete response letter, a withdrawn application, a refused
 * authorization) | source. Adding or correcting a row: bump the revision so the study is priced again.
 */
export interface PanelVote {
  symbol: string; company: string;
  /** The day the vote was public (the panel's own day); the study enters at the next open. */
  public: string;
  side: "positive" | "negative";
  yes: number; no: number;
  decision: { date: string; outcome: "approved" | "rejected" } | null;
  url: string;
}

export const PANEL_VOTES_REVISION = 1;

const ROWS = `
2019-02-26|KPTI|Karyopharm Therapeutics|-|5|8|2019-07-03|A|https://www.biocentury.com/article/302686/after-negative-panel-vote-fda-approves-karyopharm-s-multiple-myeloma-drug
2019-12-10|CORV|Correvio Pharma|-|2|11|2019-12-24|R|https://www.fiercebiotech.com/biotech/after-adcomm-rejection-correvio-pharma-hit-fda-complete-response-letter
2020-01-14|NKTR|Nektar Therapeutics|-|0|27|2020-01-14|R|https://www.sec.gov/Archives/edgar/data/906709/000121390020001039/f8k011420_nektartherap.htm
2020-10-27|NVCN|Neovasc (device)|-|3|13|2021-01-15|R|https://www.globenewswire.com/news-release/2021/01/15/2159623/0/en/Neovasc-Responds-to-FDA-Not-Approvable-Letter-Regarding-Neovasc-Reducer.html
2021-07-15|FGEN|FibroGen|-|1|13|2021-08-11|R|https://www.biopharmadive.com/news/fibrogen-fda-complete-response-anemia-drug-rejection/604817/
2021-12-08|RETA|Reata Pharmaceuticals|-|0|13|2022-02-25|R|https://www.fiercebiotech.com/biotech/fda-sticks-fork-reatas-treatment-chronic-kidney-disease
2022-02-15|ATXI|Avenue Therapeutics|-|8|14|2022-03-21|R|https://www.sec.gov/Archives/edgar/data/1644963/000110465922035868/tm229842d1_8k.htm
2022-03-30|AMLX|Amylyx (first panel)|-|4|6|2022-09-29|A|https://www.statnews.com/2022/09/07/in-reversal-fda-advisers-vote-a-second-time-to-support-approval-of-amylyxs-drug-for-als/
2022-06-17|ACAD|Acadia Pharmaceuticals|-|3|9|2022-08-04|R|https://www.businesswire.com/news/home/20220804006095/en
2022-09-22|SPPI|Spectrum Pharmaceuticals|-|4|9|2022-11-25|R|https://www.businesswire.com/news/home/20221125005059/en
2022-10-28|YMAB|Y-mAbs Therapeutics|-|0|16|2022-12-01|R|https://finance.yahoo.com/news/y-mabs-announces-complete-response-223400605.html
2022-11-09|VERU|Veru|-|5|8|2023-03-02|R|https://ir.verupharma.com/news-events/press-releases/detail/170/veru-provides-fda-update-on-request-for-emergency-use
2022-12-13|CYTK|Cytokinetics|-|3|8|2023-02-28|R|https://www.bioworld.com/articles/694707-fda-cites-weak-efficacy-as-it-hands-cytokinetics-crl-for-heart-failure-drug
2023-05-19|ICPT|Intercept Pharmaceuticals|-|2|12|2023-06-22|R|https://www.healio.com/news/gastroenterology/20230623/intercept-pivots-away-from-nash-following-second-fda-rejection-for-obeticholic-acid
2023-09-27|BCLI|BrainStorm Cell|-|1|17|2023-10-18|R|https://ir.brainstorm-cell.com/2023-10-18-BrainStorm-Cell-Therapeutics-to-Meet-with-US-FDA-to-Discuss-Development-Plan-for-NurOwn-as-a-Treatment-of-ALS
2024-10-31|LXRX|Lexicon Pharmaceuticals|-|3|11|2024-12-20|R|https://www.ajmc.com/view/fda-rejects-sotagliflozin-for-type-1-diabetes-lexicon-shifts-focus
2025-05-21|URGN|UroGen Pharma|-|4|5|2025-06-12|A|https://www.fiercepharma.com/pharma/urogens-zusduri-wins-fdas-blessing-first-therapy-certain-bladder-cancer-patients-despite
2019-09-13|AIMT|Aimmune Therapeutics|+|7|2|2020-01-31|A|https://www.allergicliving.com/2019/09/16/panel-backs-fda-approval-for-aimmunes-peanut-oit-drug/
2019-10-30|AGRX|Agile Therapeutics|+|14|1|2020-02-14|A|https://www.drugs.com/nda/twirla_191114.html
2019-11-14|AMRN|Amarin|+|16|0|2019-12-13|A|
2019-12-13|HZNP|Horizon Therapeutics|+|12|0|2020-01-21|A|
2020-10-09|ALKS|Alkermes|+|16|1|2020-11-17|R|https://investor.alkermes.com/news-releases/news-release-details/alkermes-receives-fda-complete-response-letter-related-alks-3831
2021-04-06|TMDX|TransMedics (heart)|+|12|5|2021-09-07|A|https://www.massdevice.com/fda-advisory-committee-positive-about-transmedics-ocs-heart-system/
2021-05-27|PRVB|Provention Bio|+|10|7|2021-07-06|R|https://cm.healio.com/news/endocrinology/20210706/fda-issues-complete-response-letter-for-teplizumab
2021-07-14|TMDX|TransMedics (liver)|+|12|1|2021-09-28|A|https://investors.transmedics.com/news-releases/news-release-details/transmedics-announces-positive-fda-advisory-committee-vote-ocs-0
2022-06-10|BLUE|bluebird bio|+|13|0|2022-08-17|A|https://www.fiercepharma.com/pharma/bluebird-scores-second-straight-win-high-stakes-fda-gene-therapy-meeting
2022-09-07|AMLX|Amylyx (second panel)|+|7|2|2022-09-29|A|https://www.statnews.com/2022/09/07/in-reversal-fda-advisers-vote-a-second-time-to-support-approval-of-amylyxs-drug-for-als/
2023-04-17|INVA|Innoviva|+|12|0|2023-05-23|A|https://www.cidrap.umn.edu/antimicrobial-stewardship/fda-approves-antibiotic-combination-hospital-acquired-pneumonia
2023-05-11|SPRY|ARS Pharmaceuticals|+|16|6|2023-09-19|R|https://www.drugs.com/nda/neffy_230919.html
2024-03-14|GERN|Geron|+|12|2|2024-06-06|A|https://www.fiercepharma.com/pharma/after-33-years-geron-gains-fda-nod-mds-drug-rytelo
2024-03-15|TSVT|2seventy bio|+|8|3|2024-04-04|A|https://www.businesswire.com/news/home/20240403030392/en
2024-05-23|GH|Guardant Health|+|7|2|2024-07-29|A|https://www.fda.gov/medical-devices/recently-approved-devices/shield-p230009
2024-08-02|ZVRA|Zevra Therapeutics|+|11|5|2024-09-20|A|https://www.fda.gov/news-events/press-announcements/fda-approves-first-treatment-niemann-pick-disease-type-c
2024-11-07|ICCM|IceCure Medical (device)|+|9|5|-|-|https://prnewswire.com/il/news-releases/fda-advisory-panel-votes-in-favor-of-icecures-prosense-cryoablation-benefit-risk-profile-in-early-stage-low-risk-breast-cancer-302299814.html
2026-07-30|REPL|Replimune|+|10|3|2026-08-06|A|https://ir.replimune.com/news-releases/news-release-details/replimune-announces-fda-accelerated-approval-tudriqevtm
2026-09-23|GRAL|Grail|+|7|2|-|-|https://www.statnews.com/2026/09/23/fda-advisory-panel-recommends-approval-grail-galleri-multi-cancer-blood-test/
`;

/** Pure: the rows of the list (anything that is not a row is skipped). A row with no source links to the company's 8-Ks around the vote. */
export function parsePanelVotes(rows: string): PanelVote[] {
  const out: PanelVote[] = [];
  for (const line of rows.split("\n")) {
    const f = line.trim().split("|");
    if (f.length < 8 || !/^\d{4}-\d{2}-\d{2}$/.test(f[0]) || !/^[+-]$/.test(f[3])) continue;
    const [pub, symbol, company, sign, yes, no, decided, how] = f;
    const url = f.slice(8).join("|").trim() || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=8-K&dateb=${pub.replace(/-/g, "").replace(/(\d{4})(\d{2})(\d{2})/, (_, y, m) => `${m === "12" ? Number(y) + 1 : y}${m === "12" ? "01" : String(Number(m) + 1).padStart(2, "0")}15`)}&owner=include&count=10`;
    out.push({
      symbol, company, public: pub, side: sign === "+" ? "positive" : "negative", yes: Number(yes), no: Number(no),
      decision: /^\d{4}-\d{2}-\d{2}$/.test(decided) && /^[AR]$/.test(how) ? { date: decided, outcome: how === "A" ? "approved" : "rejected" } : null, url,
    });
  }
  return out;
}

export const PANEL_VOTES: PanelVote[] = parsePanelVotes(ROWS);
