import { describe, expect, it } from "vitest";
import { rankFeed } from "@/lib/scout/newsfeed";

const now = new Date("2026-11-16T15:00:00Z");
const item = (id: string, minsAgo: number, headline: string, symbols: string[], kind: "news" | "trump" = "news") =>
  ({ id, at: new Date(now.getTime() - minsAgo * 60000).toISOString(), headline, summary: "", source: "benzinga", url: "https://x", symbols, kind });

describe("news feed ranking", () => {
  it("event words, a pile-up on one stock and a card on it lift a story; age and round-ups pull it down", () => {
    const r = rankFeed([
      item("plain", 10, "Company updates its website", ["ABC"]),
      item("event", 30, "FDA rejects drug; CEO resigns", ["XYZ"]),
      item("mine", 60, "Fermi signs lease", ["FRMI"]),
      item("old", 600, "SEC probe into lender", ["LND"]),
      item("roundup", 5, "10 stocks moving premarket", ["A", "B", "C", "D", "E", "F"]),
      item("pile1", 20, "Micron guides higher", ["MU"]), item("pile2", 40, "Micron analyst day", ["MU"]), item("pile3", 50, "Micron capex", ["MU"]),
      item("trump", 15, "Trump: 50% tariff on Taiwan chips", ["TSM"], "trump"),
    ], new Map([["FRMI", [124]]]), now);
    const by = new Map(r.map((x) => [x.id, x]));
    expect(by.get("event")!.event).not.toBeNull();
    expect(by.get("plain")!.event).toBeNull();
    expect(by.get("mine")!.cardIds).toEqual([124]);
    expect(by.get("pile1")!.buzz).toBe(3);
    const order = r.slice().sort((a, b) => b.score - a.score).map((x) => x.id);
    expect(order.indexOf("event")).toBeLessThan(order.indexOf("plain"));
    expect(order.indexOf("trump")).toBeLessThan(order.indexOf("plain"));
    expect(order.indexOf("mine")).toBeLessThan(order.indexOf("plain"));
    expect(order.indexOf("pile1")).toBeLessThan(order.indexOf("plain"));
    expect(order.indexOf("roundup")).toBeGreaterThan(order.indexOf("plain"));
    expect(order.indexOf("old")).toBeGreaterThan(order.indexOf("plain")); // ten hours old: fades below a fresh plain headline
    expect(order.at(-1)).toBe("roundup"); // a ticker round-up with no event ranks last
  });
});

describe("news feed fixes", () => {
  it("'strike price' is not a strike; a card alone lifts a fluff headline only a little", () => {
    const r = rankFeed([
      item("whale", 5, "Options Whale Alert: $950K Bullish Long Call Opened on Sagimet", ["SGMT"]),
      { ...item("fluff", 5, "Delta and Foundation complete community playground project", ["DAL"]), summary: "" },
      item("real", 5, "Delta resumes operations after nationwide FAA ground stop", ["DAL"]),
    ].map((x) => (x.id === "whale" ? { ...x, summary: "5,000 call options with a $10.00 strike price expiring January 15" } : x)), new Map([["DAL", [113]]]), now);
    const by = new Map(r.map((x) => [x.id, x]));
    expect(by.get("whale")!.event).toBeNull();
    expect(by.get("real")!.score).toBeGreaterThan(by.get("fluff")!.score);
  });
});
