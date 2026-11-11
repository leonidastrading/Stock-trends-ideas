import { describe, expect, it } from "vitest";
import { acceleration, withHistory } from "@/lib/scout/scan";
import type { Signal } from "@/lib/sources";

const sig = (source: string, value: number, baseline: number | null, p: Partial<Signal> = {}): Signal => ({
  source, metric: "m", value, baseline, changeVs12m: baseline ? value / baseline - 1 : null, asOf: "2026-11-10", note: "", ...p,
});

describe("12-month base from stored history", () => {
  it("fills in a base only when the source gave none and enough days are stored", () => {
    const out = withHistory([sig("reddit", 30, null), sig("wikipedia", 50, 40)], { "reddit:m": { avg: 10, n: 45 } });
    expect(out[0].baseline).toBe(10);
    expect(out[0].changeVs12m).toBeCloseTo(2);
    expect(out[1].baseline).toBe(40);
    expect(withHistory([sig("reddit", 30, null)], { "reddit:m": { avg: 10, n: 5 } })[0].baseline).toBeNull();
  });
  it("treats chart rank as lower-is-better", () => {
    const out = withHistory([{ ...sig("app_store", 20, null), metric: "top_free_rank" }], { "app_store:top_free_rank": { avg: 60, n: 40 } });
    expect(out[0].changeVs12m).toBeCloseTo(2);
  });
});

describe("candidate rule", () => {
  it("needs two sources up 50% or more", () => {
    expect(acceleration([sig("reddit", 30, 10), sig("wikipedia", 12, 10)], "consumer").isCandidate).toBe(false);
    const a = acceleration([sig("reddit", 30, 10), sig("wikipedia", 16, 10), sig("hacker_news", 40, 10)], "consumer");
    expect(a.isCandidate).toBe(true);
    expect(a.accelerating.map((s) => s.source).sort()).toEqual(["hacker_news", "reddit", "wikipedia"]);
    expect(a.score).toBeCloseTo(2 + 0.6 + 3);
  });
  it("keeps one signal per source and ignores unknown changes", () => {
    const a = acceleration([sig("reddit", 30, 10), sig("reddit", 50, 10, { metric: "other" }), sig("youtube", 100, null)], "platform");
    expect(a.accelerating).toHaveLength(1);
    expect(a.accelerating[0].value).toBe(50);
    expect(a.isCandidate).toBe(false);
  });
  it("an event's odds moving 10+ points is a candidate on its own, only for event terms", () => {
    const odds = sig("polymarket", 62, 50, { metric: "yes_odds_points", detail: { week_change_points: 12 } });
    expect(acceleration([odds], "event").isCandidate).toBe(true);
    expect(acceleration([odds], "consumer").isCandidate).toBe(false);
    expect(acceleration([sig("polymarket", 55, 50, { metric: "yes_odds_points", detail: { week_change_points: 5 } })], "event").isCandidate).toBe(false);
  });
});
