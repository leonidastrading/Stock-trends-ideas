import { describe, expect, it } from "vitest";
import type { WatchItem } from "@/lib/scout/store";
import { termProblem, upkeepPlan, WATCH } from "@/lib/scout/watch-terms";

let id = 0;
const item = (term: string, addedBy: string, over: Partial<WatchItem> = {}): WatchItem => ({ id: ++id, term, kind: "consumer", tickers: [], addedBy, status: "active", note: null, addedAt: `2026-11-${String(10 + (id % 15)).padStart(2, "0")}T12:00:00Z`, ...over });

describe("what can be a watch-list term", () => {
  it("is a phrase of one to four words a person would search for", () => {
    expect(termProblem("GLP-1 weight loss")).toBeNull();
    expect(termProblem("robotaxi")).toBeNull();
    expect(termProblem("AI coding assistant")).toBeNull();
    expect(termProblem("Three OPAL Fuels insiders buy shares again after a 55% fall")).toContain("more than 4 words");
    expect(termProblem("insider: OPAL")).toContain("desk label");
    expect(termProblem("Is Nvidia peaking?")).toContain("sentence");
  });
});

describe("watch-list upkeep", () => {
  it("retires the scout's headlines and card titles, keeps seeds and the user's terms whatever their length", () => {
    const items = [
      item("data center power demand", "seed"), item("my own five word term here", "vadim"),
      item("Seagate's hard-drive boom may rebound with memory", "scout"), item("nand rebound", "scout", { note: "from human-originated card #89" }),
      item("memory basket", "scout"), item("humanoid robots", "scout"), item("waiting one", "scout", { status: "proposed" }), item("a waiting headline that runs far too long", "scout", { status: "proposed" }),
    ];
    const plan = upkeepPlan(items, new Set(["memory basket"]));
    expect(plan.retire.map((r) => [r.term, r.why])).toEqual([
      ["Seagate's hard-drive boom may rebound with memory", "longer than four words"], ["nand rebound", "made from a card's title"],
      ["memory basket", "made from a card's title"], ["a waiting headline that runs far too long", "longer than four words"],
    ]);
    expect(plan.before).toEqual({ active: 6, proposed: 2 });
    expect(plan.after).toEqual({ active: 3, proposed: 1 });
  });
  it("holds the active list to its cap by retiring the scout's oldest", () => {
    const items = [...Array.from({ length: 10 }, (_, i) => item(`seed ${i}`, "seed")), ...Array.from({ length: 58 }, (_, i) => item(`scout term ${i}`, "scout", { addedAt: new Date(Date.UTC(2026, 9, 1) + i * 3600_000).toISOString() }))];
    const plan = upkeepPlan(items, new Set());
    expect(plan.after.active).toBe(WATCH.maxActive);
    expect(plan.retire).toHaveLength(8);
    expect(plan.retire.every((r) => /^scout term [0-7]$/.test(r.term) && r.why.includes("cap of 60"))).toBe(true);
  });
});
