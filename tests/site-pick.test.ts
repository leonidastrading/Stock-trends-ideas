import { describe, expect, it } from "vitest";
import { articleOutcomes, pickArticles, relevance } from "@/lib/scout/site-pick";

const a = (n: number, title: string, summary = "") => ({ url: `https://s/${n}`, title, summary });

describe("which of a site's new articles are read", () => {
  it("ranks a company event above politics", () => {
    expect(relevance(a(1, "Nvidia (NASDAQ: NVDA) cuts guidance as chip export controls bite"))).toBeGreaterThan(relevance(a(2, "Senate campaign heats up before the election")));
  });
  it("reads the six most relevant when there are more, in their original order", () => {
    const list = [
      a(1, "Election night: what to watch"), a(2, "Senate hearing on immigration"), a(3, "Celebrity trial verdict"), a(4, "Border crime debate"),
      a(5, "Oil jumps as OPEC cuts supply"), a(6, "Fed signals a rate cut"), a(7, "Micron earnings beat; shares rise 8%"), a(8, "Copper shortage hits orders"),
      a(9, "Treasury yields fall after CPI"), a(10, "Boeing wins a $4bn contract"),
    ];
    const { read, skipped } = pickArticles(list, 6);
    expect(read.map((x) => x.url)).toEqual([5, 6, 7, 8, 9, 10].map((n) => `https://s/${n}`));
    expect(skipped).toHaveLength(4);
    expect(pickArticles(list.slice(0, 3), 6).skipped).toEqual([]);
  });
});

describe("each article's own result", () => {
  const arts = [{ ...a(1, "Micron warns on NAND pricing"), text: "MU guided lower." }, { ...a(2, "A walk through Vienna"), text: "No companies here." }, { ...a(3, "Seagate's hard drives are sold out"), text: "STX capacity is booked." }];
  it("goes to the articles the model cited", () => {
    const out = articleOutcomes(arts, [{ term: "NAND price turn", tickers: ["MU"], sources: ["https://s/1"] }, { term: "hard drive shortage", tickers: ["STX"], sources: ["https://s/3"] }]);
    expect([...out.values()]).toEqual(["read: NAND price turn", "read: no tradeable idea", "read: hard drive shortage"]);
  });
  it("falls back to the ticker named in the article when the model cited none", () => {
    const out = articleOutcomes(arts, [{ term: "NAND price turn", tickers: ["MU"] }]);
    expect(out.get("https://s/1")).toBe("read: NAND price turn");
    expect(out.get("https://s/3")).toBe("read: no tradeable idea");
  });
});
