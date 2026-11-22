import { describe, expect, it } from "vitest";
import { digestLine, parseDigests } from "@/lib/scout/site-digest";

describe("website digests", () => {
  it("matches the model's digests back to the articles, cleans tickers, drops empty ones", () => {
    const articles = [
      { url: "https://www.dbresearch.com/a.pdf", title: "LatAm's silicon dividend", published: "2026-11-20T00:00:00.000Z" },
      { url: "https://www.dbresearch.com/b", title: "Chart of the day", published: null },
    ];
    const d = parseDigests(JSON.stringify({ articles: [
      { n: 1, tickers: ["$mu", "TSM", "not a ticker", "MU"], summary: "Deutsche Bank sees Mexico and Brazil gaining from US AI capex.", claims: ["Mexico server exports up 40% in 2026", ""] },
      { n: 2, tickers: [], summary: "  ", claims: [] },
      { n: 7, tickers: ["X"], summary: "no such article", claims: [] },
    ] }), articles);
    expect(d).toEqual([{ url: "https://www.dbresearch.com/a.pdf", title: "LatAm's silicon dividend", published: "2026-11-20T00:00:00.000Z", tickers: ["MU", "TSM"], summary: "Deutsche Bank sees Mexico and Brazil gaining from US AI capex.", claims: ["Mexico server exports up 40% in 2026"] }]);
    expect(digestLine({ ...d[0], siteId: 1, site: "dbresearch.com", createdAt: "" })).toBe('dbresearch.com 2026-11-20: "LatAm\'s silicon dividend" [MU, TSM]: Deutsche Bank sees Mexico and Brazil gaining from US AI capex. Claims: Mexico server exports up 40% in 2026 (https://www.dbresearch.com/a.pdf)');
  });
});
