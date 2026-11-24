import { describe, expect, it } from "vitest";
import { scoreTone } from "../lib/scout/score-tone";

describe("score colours", () => {
  it("green from 70, amber from 50, red below (the Ideas filter bands)", () => {
    expect([100, 70, 69, 50, 49, 0].map((v) => scoreTone(v))).toEqual(["pos", "pos", "warn", "warn", "neg", "neg"]);
  });
  it("rank has its own, lower bands (it is novelty x materiality)", () => {
    expect([50, 49, 30, 29, 15].map((v) => scoreTone(v, "rank"))).toEqual(["pos", "warn", "warn", "neg", "neg"]);
  });
});
