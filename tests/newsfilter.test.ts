import { describe, expect, it } from "vitest";
import { mergeKept, parseNewsfilter } from "@/lib/sources/newsfilter";

const now = new Date("2026-11-23T15:00:00Z");
const resp = { from: 0, size: 2, articles: [
  { id: "ee56421c7fa15419833d3f9ccb984e09", title: "Korea readies stock stabilization fund", description: "The government...", url: "https://newsfilter.io/articles/x", sourceUrl: "https://www.cnbc.com/x", publishedAt: "2026-11-23T08:40:02.000-05:00", source: { id: "cnbc", name: "CNBC" }, symbols: ["EWY", "bad-sym"] },
  { id: "abc", title: "No date" },
] };

describe("newsfilter", () => {
  it("parses articles into feed items with the publisher's link", () => {
    const [a, ...rest] = parseNewsfilter(resp);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ id: "nfee56421c7fa15419833d3f9ccb984e09", at: "2026-11-23T13:40:02.000Z", headline: "Korea readies stock stabilization fund", source: "CNBC", url: "https://www.cnbc.com/x", symbols: ["EWY"], kind: "news" });
  });

  it("keeps 26 hours, newest first, one per id", () => {
    const [a] = parseNewsfilter(resp);
    const old = { ...a, id: "nfold", at: "2026-11-22T10:00:00Z" };
    const newer = { ...a, at: "2026-11-23T14:00:00Z" };
    expect(mergeKept([a, old], [newer], now).map((i) => [i.id, i.at])).toEqual([["nfee56421c7fa15419833d3f9ccb984e09", "2026-11-23T14:00:00Z"]]);
  });
});
