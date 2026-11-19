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

  it("routine volatility pauses sink to the bottom of Top and do not pile up; news-pending halts still rank", () => {
    const now = new Date("2026-11-19T15:55:00Z");
    const pause = (n: number, sym = "TDTH") => ({ id: `p${n}${sym}`, at: new Date(now.getTime() - n * 20 * 60_000).toISOString(), headline: `Trading halted: ${sym} (Trident Dgtl Tch Hld Cl B Ords), volatility pause (limit up-limit down); resumes 10:37:48 ET`, summary: "Nasdaq halt, reason code LUDP.", source: "Nasdaq halts", url: "", symbols: [sym], kind: "news" as const });
    const r = rankFeed([
      pause(1), pause(2), pause(3), pause(4), pause(1, "MU"),
      { id: "n1", at: new Date(now.getTime() - 80 * 60_000).toISOString(), headline: "NVIDIA receives analyst downgrades following CEO resignation", summary: "", source: "fiscal.ai", url: "", symbols: ["NVDA"], kind: "news" as const },
      { id: "h1", at: new Date(now.getTime() - 30 * 60_000).toISOString(), headline: "Trading halted: ACME (Acme Corp), news pending", summary: "Nasdaq halt, reason code T1.", source: "Nasdaq halts", url: "", symbols: ["ACME"], kind: "news" as const },
    ], new Map([["NVDA", [217]], ["MU", [12]]]), now).sort((a, b) => b.score - a.score);
    expect(r.slice(0, 2).map((x) => x.id)).toEqual(["n1", "h1"]);
    const tdth = r.filter((x) => x.symbols[0] === "TDTH");
    expect(tdth.every((x) => x.event === "paused" && x.buzz === 0 && x.score <= 0.1)).toBe(true);
    expect(r.find((x) => x.id === "p1MU")!.score).toBeGreaterThan(tdth[0].score); // on a card: still low, but above other pauses
  });
});
