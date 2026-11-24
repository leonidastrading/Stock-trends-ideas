import { describe, expect, it } from "vitest";
import { mismatch, panelNoteText, pendingSymbols, type PanelNote } from "../lib/scout/panel-watch";
import type { FdaEvent } from "../lib/sources/pharma";

const ev = (over: Partial<FdaEvent>): FdaEvent => ({ company: "Co", symbol: "AAA", otherSymbols: [], drug: "drug", when: "", date: null, month: null, event: "PDUFA", outcome: "Pending", status: "", note: "", detailUrl: null, ...over });
const note = (over: Partial<PanelNote> = {}): PanelNote => ({ symbol: "CAPR", checkedAt: "2026-11-20T12:00:00Z", filing: { form: "10-Q", filed: "2026-11-10", url: "https://www.sec.gov/x", accession: "a" }, vote: { side: "negative", yes: 3, no: 9, said: "2026-07-29", sentence: "the advisory committee voted 3 to 9 on whether the data support effectiveness." }, bullishPct: 88, tagged: 25, ...over });

describe("which stocks have an FDA decision coming", () => {
  it("takes pending decisions with a ticker, soonest first, once each; not decided ones, not far-off ones", () => {
    const list = pendingSymbols([
      ev({ symbol: "LATE", date: "2027-01-20" }), ev({ symbol: "SOON", date: "2026-11-28" }), ev({ symbol: "SOON", date: "2026-12-05" }),
      ev({ symbol: "DONE", date: "2026-11-27", outcome: "Approved" }), ev({ symbol: null, date: "2026-11-27" }), ev({ symbol: "PAST", date: "2026-11-01" }),
      ev({ symbol: "FAR", date: "2027-09-01" }), ev({ symbol: "LOOSE", month: "2026-12" }), ev({ symbol: "OLDMONTH", month: "2026-10" }),
    ], "2026-11-24");
    expect(list).toEqual(["SOON", "LOOSE", "LATE"]);
  });
});

describe("the crowd against the panel", () => {
  it("flags a bullish crowd after a negative vote, and the mirror case", () => {
    expect(mismatch(note())).toMatch(/voted against, yet 88% of the crowd is bullish/);
    expect(mismatch(note({ vote: { ...note().vote!, side: "positive" }, bullishPct: 30 }))).toMatch(/in favour, yet only 30%/);
  });
  it("says nothing when they agree, when few messages carry a view, or when there is no vote", () => {
    expect(mismatch(note({ bullishPct: 35 }))).toBeNull();
    expect(mismatch(note({ tagged: 3 }))).toBeNull();
    expect(mismatch(note({ bullishPct: null }))).toBeNull();
    expect(mismatch(note({ vote: null }))).toBeNull();
    expect(mismatch(note({ vote: { ...note().vote!, side: "split" } }))).toBeNull();
  });
  it("writes the note for a research brief, with the filing it came from", () => {
    const t = panelNoteText(note())!;
    expect(t).toMatch(/3–9 against on 2026-07-29 \(from the company's 10-Q filed 2026-11-10\)/);
    expect(t).toMatch(/88% of 25 sentiment-tagged/);
    expect(t).toMatch(/Mismatch:/);
    expect(panelNoteText(note({ vote: null }))).toBeNull();
  });
});
