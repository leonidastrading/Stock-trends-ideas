import { describe, expect, it } from "vitest";
import { duplicateOf, existingCalls, mergeSameStock } from "@/lib/scout/dedupe";
import { importItemSchema } from "@/lib/scout/importer";
import type { Candidate, StoredCard, Track } from "@/lib/scout/store";

const card = (id: number, symbol: string, direction: "long" | "short", origin: "scout" | "human" = "human") => ({ id, createdAt: "2026-11-14T23:42:00Z", primaryTicker: symbol, direction, origin } as unknown as StoredCard);
const cand = (cardId: number, term: string) => ({ cardId, term } as unknown as Candidate);

describe("one card per stock and direction per player", () => {
  const existing = existingCalls(
    [card(1, "PRE", "long"), card(2, "AAON", "short", "scout"), card(3, "SATS", "long"), card(4, "NVDA", "long", "scout")],
    [cand(1, "Prenetics IM8 Q3 beat"), cand(2, "AAON data-center slowdown"), cand(3, "inbox: SATS spectrum"), cand(4, "story: NVDA CEO exit")],
    [{ cardId: 3, excluded: "followed the wrong security" } as unknown as Track],
  );

  it("the second PRE idea from the same paste is a repeat; another player's call is not", () => {
    expect(duplicateOf(existing, { origin: "human", term: "Prenetics cheap on EV/sales", symbol: "PRE", direction: "long" })?.cardId).toBe(1);
    expect(duplicateOf(existing, { origin: "human", term: "Prenetics cheap on EV/sales", symbol: "pre" })?.cardId).toBe(1); // before research: any direction
    expect(duplicateOf(existing, { origin: "human", term: "Prenetics fade", symbol: "PRE", direction: "short" })).toBeNull(); // the opposite call is a new call
    expect(duplicateOf(existing, { origin: "human", term: "inbox: Prenetics", symbol: "PRE", direction: "long" })).toBeNull(); // the bot is a different player
    expect(duplicateOf(existing, { origin: "scout", term: "AAON backlog", symbol: "AAON", direction: "short" })?.cardId).toBe(2);
  });

  it("an excluded card does not block, and the story desk is exempt", () => {
    expect(duplicateOf(existing, { origin: "human", term: "inbox: SATS again", symbol: "SATS", direction: "long" })).toBeNull();
    expect(duplicateOf(existing, { origin: "scout", term: "story: NVDA stage 3", symbol: "NVDA", direction: "long" })).toBeNull();
    expect(duplicateOf(existing, { origin: "human", term: "no ticker", symbol: undefined })).toBeNull();
  });

  it("merges ideas about the same stock and direction from one document", () => {
    const it = (term: string, tickers: string[], direction?: "long" | "short", catalyst_date?: string) => importItemSchema.parse({ observation: `${term} facts`, term, kind: "event", tickers, direction, catalyst_date, source: "you" });
    const merged = mergeSameStock([it("Prenetics Q3 beat", ["PRE"], "long"), it("Prenetics cheap, insiders buying", ["PRE", "XYZ"], "long", "2026-11-20"), it("AAON slowdown", ["AAON"], "short"), it("PRE no view", ["$pre"])]);
    expect(merged.map((m) => m.term)).toEqual(["Prenetics Q3 beat", "AAON slowdown"]);
    expect(merged[0]).toMatchObject({ tickers: ["PRE", "XYZ", "$pre"], direction: "long", catalyst_date: "2026-11-20" });
    expect(merged[0].observation).toBe("Prenetics Q3 beat facts Also in the same document (Prenetics cheap, insiders buying): Prenetics cheap, insiders buying facts Also in the same document (PRE no view): PRE no view facts");
    expect(mergeSameStock([it("PRE long", ["PRE"], "long"), it("PRE short", ["PRE"], "short")])).toHaveLength(2);
  });
});

describe("repeats logged before the duplicate check", () => {
  it("the later PRE card from the same inbox batch folds under the first and is scored once", async () => {
    const { repeatCards } = await import("@/lib/scout/dedupe");
    const c = (id: number, at: string, sym: string, dir: "long" | "short", origin: "scout" | "human" = "human") => ({ id, createdAt: at, origin, primaryTicker: sym, direction: dir });
    const terms = new Map([[150, "inbox: Prenetics Q3 beat"], [151, "inbox: AXON and APP"], [152, "inbox: PRE cheap EV/sales rerating"], [160, "Prenetics again"], [170, "inbox: PRE later"], [180, "story: PRE → PRE"], [181, "story: PRE stage 2 → PRE"]]);
    const r = repeatCards([
      c(152, "2026-11-14T23:42:10Z", "PRE", "long"), c(150, "2026-11-14T23:42:00Z", "PRE", "long"), c(151, "2026-11-14T23:42:05Z", "AXON", "long"),
      c(160, "2026-11-15T10:00:00Z", "PRE", "long"), // you, not your bot: its own call
      c(170, "2026-12-10T10:00:00Z", "PRE", "long"), // more than 14 days later: a new call
      c(180, "2026-11-15T10:00:00Z", "PRE", "long", "scout"), c(181, "2026-11-16T10:00:00Z", "PRE", "long", "scout"), // story desk is exempt
    ], terms);
    expect([...r.entries()]).toEqual([[152, 150]]);
  });
});
