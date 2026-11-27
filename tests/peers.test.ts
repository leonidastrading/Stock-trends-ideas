import { describe, expect, it } from "vitest";
import { peerCalls, peerConflicts, peerNote, peersText, TOO_WIDE, type IndustryMap } from "@/lib/scout/peers";

const at = "2026-11-27T00:00:00Z";
const map: IndustryMap = {
  LEN: { sic: "1531", label: "operative builders", at }, TOL: { sic: "1531", label: "operative builders", at }, DHI: { sic: "1531", label: "operative builders", at },
  CRM: { sic: "7372", label: "services-prepackaged software", at }, SNOW: { sic: "7372", label: "services-prepackaged software", at }, SPY: { sic: "", label: "", at },
};
const calls = [
  { symbol: "TOL", direction: "short" as const, cardId: 464 }, { symbol: "DHI", direction: "long" as const, cardId: 300 }, { symbol: "LEN", direction: "short" as const, cardId: 241 },
  { symbol: "SNOW", direction: "short" as const, cardId: 500 }, { symbol: "SPY", direction: "short" as const, cardId: 501 },
];

describe("opposite calls on companies in the same industry", () => {
  it("finds the open calls on a stock's industry peers, not on the stock itself", () => {
    expect(peerCalls("LEN", calls, map).map((c) => c.cardId)).toEqual([464, 300]);
    expect(peerConflicts("LEN", "long", calls, map).map((c) => [c.cardId, c.symbol])).toEqual([[464, "TOL"]]); // long Lennar against short Toll
    expect(peerConflicts("LEN", "short", calls, map).map((c) => c.symbol)).toEqual(["DHI"]);
  });
  it("leaves out industries too wide to move together, and stocks with no industry on file", () => {
    expect(TOO_WIDE.has("7372")).toBe(true);
    expect(peerCalls("CRM", calls, map)).toEqual([]); // all software is not one trade
    expect(peerCalls("SPY", calls, map)).toEqual([]);
    expect(peerCalls("ZZZZ", calls, map)).toEqual([]);
  });
  it("tells research what to do about a call the other way, and writes the note a card carries", () => {
    const t = peersText("LEN", peerCalls("LEN", calls, map), (id) => (id === 464 ? "Short TOL: builders expect fewer homes" : undefined))!;
    expect(t).toContain("OTHER COMPANIES IN LEN'S INDUSTRY (operative builders)");
    expect(t).toContain("- card #464: short TOL: Short TOL: builders expect fewer homes");
    expect(t).toContain('begins "Against open call #N:"');
    expect(peersText("CRM", [], () => undefined)).toBeNull();
    expect(peerNote(peerConflicts("LEN", "long", calls, map))).toBe("opposite call on a peer in the same industry (operative builders): #464 short TOL");
    expect(peerNote([])).toBeNull();
  });
});
