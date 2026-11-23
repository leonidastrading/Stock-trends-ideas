import { describe, expect, it } from "vitest";
import { markSeen } from "../lib/seen";

const MIN = 60_000, DAY = 86400_000;

describe("new since you last looked", () => {
  it("flags items never shown before and remembers them", () => {
    const r = markSeen({}, ["a", "b"], 1000);
    expect(r.fresh).toEqual(["a", "b"]);
    expect(r.next).toEqual({ a: 1000, b: 1000 });
  });

  it("flags only what was not there last time", () => {
    const first = markSeen({}, ["a", "b"], 0).next;
    const r = markSeen(first, ["a", "b", "c"], 60 * MIN);
    expect(r.fresh).toEqual(["c"]);
  });

  it("keeps a flag through a reload a few minutes later, then drops it", () => {
    const first = markSeen({}, ["a"], 0).next;
    expect(markSeen(first, ["a"], 5 * MIN).fresh).toEqual(["a"]);
    expect(markSeen(first, ["a"], 16 * MIN).fresh).toEqual([]);
  });

  it("forgets items that left the list days ago, never ones still listed", () => {
    const r = markSeen({ gone: 0, still: 0 }, ["still"], 5 * DAY);
    expect(r.next).toEqual({ still: 0 });
    expect(r.fresh).toEqual([]);
  });
});
