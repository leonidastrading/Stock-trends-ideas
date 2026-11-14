import { describe, expect, it } from "vitest";
import { coverageTrend, publicAttention, summarizeViews } from "@/lib/scout/attention";
import { assessGap } from "@/lib/scout/followup";
import { parseStoryTriage, STORY_JSON_SCHEMA, STORY_SYSTEM_PROMPT } from "@/lib/scout/stories";

// 2026-11-09 is a Monday.
const c = (pairs: Array<[string, number]>) => pairs.map(([date, stories]) => ({ date, stories }));

describe("coverage trend", () => {
  it("building: up three weekdays in a row (the affair story growing every day)", () => {
    const t = coverageTrend(c([["2026-11-02", 7], ["2026-11-03", 6], ["2026-11-04", 9], ["2026-11-05", 15], ["2026-11-06", 24]]), "2026-11-07");
    expect(t).toMatchObject({ building: true, risingDays: 3 });
    expect(t.line).toBe("coverage 6 → 9 → 15 → 24 stories/day over the last 4 weekdays (up 3 days in a row: building)");
  });
  it("building: a jump to 1.5x the days before, while still rising", () => {
    expect(coverageTrend(c([["2026-11-04", 10], ["2026-11-05", 10], ["2026-11-06", 20]]), "2026-11-07")).toMatchObject({ building: true, risingDays: 1 });
  });
  it("not building: falling, too small, or a Monday after a quiet weekend", () => {
    expect(coverageTrend(c([["2026-11-05", 5], ["2026-11-06", 4]]), "2026-11-07").building).toBe(false);
    expect(coverageTrend(c([["2026-11-04", 1], ["2026-11-05", 2], ["2026-11-06", 3]]), "2026-11-07").building).toBe(false); // under 4 a day
    // Fri 10, Sat 2, Sun 1, Mon 11: weekends are skipped, so Monday vs Friday is barely up.
    const monday = coverageTrend(c([["2026-11-05", 10], ["2026-11-06", 10], ["2026-11-07", 2], ["2026-11-08", 1], ["2026-11-09", 11]]), "2026-11-10");
    expect(monday.days.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]);
    expect(monday.building).toBe(false);
    expect(coverageTrend(c([["2026-11-06", 30]]), "2026-11-07").building).toBe(false); // one day of data: no jump test
  });
  it("today's partial count is ignored", () => {
    expect(coverageTrend(c([["2026-11-07", 99]]), "2026-11-07").days.every((d) => d.stories === 0)).toBe(true);
  });
  it("a growing story counts for the reaction-gap check even before it is twice the old pace", () => {
    const g = assessGap({
      key: "NVDA", ticker: "NVDA", storyDate: "2026-10-28", today: "2026-11-06", baselinePerDay: 20,
      counts: c([["2026-10-30", 21], ["2026-11-02", 24], ["2026-11-03", 27], ["2026-11-04", 31], ["2026-11-05", 36]]),
      bars: [{ symbol: "NVDA", date: "2026-10-27", o: 200, h: 200, l: 200, c: 200, v: 1 }, { symbol: "NVDA", date: "2026-11-05", o: 196, h: 196, l: 196, c: 196, v: 1 }],
      spyBars: [{ symbol: "SPY", date: "2026-10-27", o: 600, h: 600, l: 600, c: 600, v: 1 }, { symbol: "SPY", date: "2026-11-05", o: 600, h: 600, l: 600, c: 600, v: 1 }],
    });
    expect(g).toMatchObject({ loud: false, building: true, quiet: true, gap: true });
    expect(g.why).toMatch(/growing.*up 4 days in a row/);
  });
});

describe("public attention (Wikipedia)", () => {
  const series = (n: number, base: number, tail: number[]) => [
    ...Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, views: base })),
    ...tail.map((views, i) => ({ date: `2026-11-0${i + 1}`, views })),
  ];
  it("latest day vs the 30 days before the story, and the rising streak", () => {
    const a = summarizeViews("Jensen Huang", "Jensen Huang", series(27, 9000, [20000, 45000, 90000]), "2026-10-28")!;
    expect(a).toMatchObject({ latest: 90000, before: 9000, multiple: 10, risingDays: 3 });
    expect(a.line).toBe('Wikipedia "Jensen Huang": 90k views on 2026-11-03 vs 9,000/day in the 30 days before the story (10.0x), rising 3 days in a row');
    expect(summarizeViews("x", "x", [], "2026-10-28")).toBeNull();
  });
  it("finds the article, fetches daily views, never throws", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      if (url.includes("list=search")) return new Response(JSON.stringify({ query: { search: [{ title: url.includes("Nobody") ? "" : "Jensen Huang" }] } }));
      if (url.includes("pageviews")) return new Response(JSON.stringify({ items: [{ timestamp: "2026102000", views: 9000 }, { timestamp: "2026110300", views: 90000 }] }));
      return new Response("no", { status: 500 });
    }) as unknown as typeof fetch;
    const out = await publicAttention(["Jensen Huang", "Jensen Huang", "Nobody"], "2026-10-28", "2026-11-04", fake);
    expect(out.map((a) => a.article)).toEqual(["Jensen Huang"]);
    expect(urls.find((u) => u.includes("pageviews"))).toMatch(/Jensen_Huang\/daily\/20260923\/20261103$/);
    const broken = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await publicAttention(["A B"], "2026-10-28", "2026-11-04", broken)).toEqual([]);
  });
});

describe("desk: forced flows, growing attention, names", () => {
  it("prompt and schema", () => {
    expect(STORY_SYSTEM_PROMPT).toMatch(/who is now forced to buy or sell\?/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/index inclusion/);
    expect(STORY_SYSTEM_PROMPT).toMatch(/Attention that grows every day/);
    const props = (STORY_JSON_SCHEMA.properties.stories.items as { required: readonly string[] }).required;
    expect(props).toEqual(expect.arrayContaining(["company", "people"]));
    const t = parseStoryTriage(JSON.stringify({ stories: [{ key: "NVDA", summary: "s", company: "Nvidia", people: ["Jensen Huang"], skip: true, skip_reason: "denied report", trades: [] }] }));
    expect(t.stories[0]).toMatchObject({ company: "Nvidia", people: ["Jensen Huang"] });
    const old = parseStoryTriage(JSON.stringify({ stories: [{ key: "X", summary: "s", skip: true, skip_reason: "r", trades: [] }] }));
    expect(old.stories[0]).toMatchObject({ company: "", people: [] });
  });
});
