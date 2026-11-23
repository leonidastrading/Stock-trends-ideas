import { describe, expect, it } from "vitest";
import { splitCheck } from "@/lib/scout/tracking";

describe("stock splits after a paper entry", () => {
  it("tells a split from a small correction and from bad data", () => {
    expect(splitCheck(101, 100)).toEqual({ kind: "same" });
    expect(splitCheck(20.1, 100)).toEqual({ kind: "split", ratio: 0.2 }); // 5-for-1 forward split
    expect(splitCheck(50, 5)).toEqual({ kind: "split", ratio: 10 }); // 1-for-10 reverse split
    expect(splitCheck(15, 100)).toEqual({ kind: "mismatch", ratio: 0.15 }); // not a standard ratio: check the data
  });
});
