import { describe, expect, it } from "vitest";
import { pickedByModel, ruleLine } from "@/lib/scout/rule-lines";
import { boardLines, byVerdict, score, storiesOf, studyReason, toRound, trimmedMean, verdictGroup } from "@/lib/scout/scoreboard";
import type { IdeaResult } from "@/lib/scout/scoring";
import { borrowOf } from "@/lib/scout/price-sanity";

const idea = (id: number, symbol: string, direction: "long" | "short", entryDate: string, vsSector: number | null, closed = true, vsSpy = vsSector): IdeaResult => ({
  cardId: id, origin: "scout", tapped: false, kind: "event", status: "promoted", rankScore: 50, symbol, direction, entryDate, exitDate: closed ? "2026-12-20" : null, closed,
  ret: 0, spyRet: 0, sectorRet: 0, excess: vsSpy, excessSector: vsSector, maxDrawdownPct: 0, baseline: [],
});
const round = (i: IdeaResult, player: Parameters<typeof toRound>[1] = "inbox_bot", term?: string) => toRound(i, player, 60, true, { versionId: 1, term });

describe("one result per story", () => {
  it("counts a repeated call on the same stock and side once, at its first call", () => {
    const rounds = [
      round(idea(1, "MU", "long", "2026-11-16", -0.2)), round(idea(2, "MU", "long", "2026-11-16", -0.2)), round(idea(3, "MU", "long", "2026-11-20", -0.1)),
      round(idea(4, "MU", "short", "2026-11-16", 0.03)), // the other side is another story
      round(idea(5, "MU", "long", "2026-12-05", 0.05)), // more than ten days later: a new story
      round(idea(6, "MU", "long", "2026-11-17", 0.5), "you"), // another player's own story
    ];
    const s = storiesOf(rounds);
    expect(s.map((x) => [x.player, x.direction, x.first.cardId, x.calls])).toEqual([["inbox_bot", "long", 1, 3], ["inbox_bot", "long", 5, 1], ["inbox_bot", "short", 4, 1], ["you", "long", 6, 1]]);
  });
});

describe("the leaderboard", () => {
  it("keeps longs and shorts on separate lines and scores against the sector fund", () => {
    const rounds = [
      round(idea(1, "AAA", "long", "2026-11-02", 0.10, true, 0.30)), round(idea(2, "BBB", "long", "2026-11-03", -0.02)), round(idea(3, "CCC", "long", "2026-11-04", 0.01)), round(idea(4, "DDD", "long", "2026-11-05", 0.04, false)),
      round(idea(5, "EEE", "short", "2026-11-02", -0.05)),
    ];
    const lines = boardLines(rounds);
    expect(lines.map((l) => [l.player, l.side])).toEqual([["inbox_bot", "long"], ["inbox_bot", "short"]]);
    expect(lines[0]).toMatchObject({ stories: 4, closed: 3, open: 1, wins: 2, median: 10, trimmed: 10, banked: 90, bankedSpy: 290, inPlay: 40 });
    expect(lines[0].best?.cardId).toBe(1);
    expect(lines[1]).toMatchObject({ closed: 1, wins: 0, median: -50, trimmed: null, banked: -50 });
    // A card with no sector fund price falls back to its points against SPY.
    expect(score(round(idea(9, "ZZZ", "long", "2026-11-02", null, true, 0.02)))).toBe(20);
  });
  it("takes the best and worst out of the mean", () => {
    expect(trimmedMean([800, 10, -20, 30, -900])).toBe(7);
    expect(trimmedMean([5, 6])).toBeNull();
  });
});

describe("study-only desks", () => {
  it("are rumors, themes and Congress clusters", () => {
    expect(studyReason("scout_rumors")).toContain("already reported");
    expect(studyReason("scout_themes")).toContain("repeated");
    expect(studyReason("scout_filings", "congress: PLD cluster")).toContain("months late");
    expect(studyReason("scout_filings", "insider: OPAL")).toBeNull();
    expect(round(idea(1, "PLD", "long", "2026-11-02", 0.1), "scout_filings", "congress: PLD").study).toBeTruthy();
    expect(round(idea(2, "MU", "long", "2026-11-02", 0.1), "scout_story", "story: x").study).toBeNull();
  });
});

describe("the thesis verdict beside the points", () => {
  it("groups verdicts into three words and reports the hit rate of each", () => {
    expect([verdictGroup("played_out"), verdictGroup("did_not"), verdictGroup("mixed"), verdictGroup("too_early"), verdictGroup(undefined)]).toEqual(["played out", "did not play out", "cannot tell", "cannot tell", "no check yet"]);
    const rounds = [round(idea(1, "AAA", "short", "2026-11-02", 0.13)), round(idea(2, "BBB", "long", "2026-11-02", 0.04)), round(idea(3, "CCC", "long", "2026-11-02", -0.06)), round(idea(4, "DDD", "long", "2026-11-02", 0.02, false))];
    const v = byVerdict(rounds, (id) => ({ 1: "did_not", 2: "played_out", 3: "played_out" } as Record<number, string>)[id]);
    expect(v.find((x) => x.verdict === "played out")).toMatchObject({ n: 2, wins: 1, hitRate: 0.5, median: -10 });
    expect(v.find((x) => x.verdict === "did not play out")).toMatchObject({ n: 1, wins: 1, median: 130 }); // made money, thesis did not play out
    expect(v.find((x) => x.verdict === "no check yet")!.n).toBe(0);
  });
});

describe("rule lines", () => {
  it("score each trade once against SPY", () => {
    const l = ruleLine("Down drift list", "", "short", [{ vsSpy: 0.05, closed: true }, { vsSpy: -0.02, closed: true }, { vsSpy: 0.01, closed: true }, { vsSpy: 0.03, closed: false }, { vsSpy: null, closed: false }]);
    expect(l).toMatchObject({ trades: 5, open: 2, closed: 3, wins: 2, median: 10, trimmed: 10, banked: 40, inPlay: 30 });
    expect(l.hitRate).toBeCloseTo(2 / 3, 5);
  });
  it("knows which Drift setups the model also wrote a card on", () => {
    const cards = [{ symbol: "MNRO", createdAt: "2026-11-25T15:00:00Z" }, { symbol: "FCX", createdAt: "2026-10-01T15:00:00Z" }];
    expect(pickedByModel({ symbol: "MNRO", listedAt: "2026-11-24T14:40:00Z" }, cards)).toBe(true);
    expect(pickedByModel({ symbol: "FCX", listedAt: "2026-11-24T14:40:00Z" }, cards)).toBe(false); // a card from weeks before is another setup
    expect(pickedByModel({ symbol: "PRLB", listedAt: "2026-11-24T14:40:00Z" }, cards)).toBe(false);
  });
});

describe("borrow at entry", () => {
  it("reads the broker's record", () => {
    expect(borrowOf({ shortable: true, easyToBorrow: true })).toBe("easy");
    expect(borrowOf({ shortable: true, easyToBorrow: false })).toBe("hard");
    expect(borrowOf({ shortable: false })).toBe("not shortable");
    expect(borrowOf({})).toBeNull();
    expect(borrowOf(null)).toBeNull();
  });
});
