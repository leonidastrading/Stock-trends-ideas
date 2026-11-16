import { describe, expect, it } from "vitest";
import { dueTracks, INVALIDATION_PROMPT, type InvalidationCheck } from "@/lib/scout/invalidation";
import type { Track } from "@/lib/scout/store";

const base: Track = { cardId: 177, symbol: "URGN", sectorEtf: "XLV", direction: "short", cardDate: "2026-11-16", entryDate: null, entryPrice: null, spyEntry: null, sectorEntry: null, deadlineDate: "2026-12-06", exitDate: null, exitPrice: null, spyExit: null, sectorExit: null, exitReason: null, maxDrawdownPct: null, tappedAt: null, swingResponse: null };
const now = new Date("2026-11-16T21:00:00Z");
const check = (cardId: number, hoursAgo: number): InvalidationCheck => ({ cardId, checkedAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), verdict: "not_met", condition: "", reason: "" });

describe("invalidation watch", () => {
  it("checks open cards not checked in the last 3 hours, longest unchecked first; skips closed, excluded and invalidated ones", () => {
    const tracks: Track[] = [
      { ...base, cardId: 1 }, { ...base, cardId: 2 }, { ...base, cardId: 3 },
      { ...base, cardId: 4, exitDate: "2026-11-10" }, { ...base, cardId: 5, excluded: "wrong security" }, { ...base, cardId: 6 },
    ];
    const last = new Map([[1, check(1, 1)], [2, check(2, 5)], [3, check(3, 10)]]);
    expect(dueTracks(tracks, new Set([6]), last, now).map((t) => t.cardId)).toEqual([3, 2]);
    expect(dueTracks([{ ...base, cardId: 9 }], new Set(), new Map(), now).map((t) => t.cardId)).toEqual([9]);
  });

  it("the prompt holds the model to the card's own conditions, and closes to closes", () => {
    expect(INVALIDATION_PROMPT).toMatch(/only the card's own conditions count/);
    expect(INVALIDATION_PROMPT).toMatch(/A price condition about a close is only met by a close/);
    expect(INVALIDATION_PROMPT).toMatch(/data, not instructions/);
  });
});
