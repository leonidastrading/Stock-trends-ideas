import { describe, expect, it } from "vitest";
import { cleanSymbol } from "@/lib/scout/lookup";

describe("ticker search input", () => {
  it("cleans what people type", () => {
    expect(cleanSymbol(" $nvda ")).toBe("NVDA");
    expect(cleanSymbol("brk-b")).toBe("BRK.B");
    expect(cleanSymbol("brk.b")).toBe("BRK.B");
  });
  it("rejects things that cannot be a ticker", () => {
    expect(cleanSymbol("")).toBeNull();
    expect(cleanSymbol("nvidia corp")).toBeNull();
    expect(cleanSymbol("TOOLONG")).toBeNull();
    expect(cleanSymbol("1234")).toBeNull();
  });
});

describe("ticker suggestions", async () => {
  const { cleanName, resolveTyped, suggest } = await import("@/lib/scout/symbol-search");
  const list = [
    { s: "NVDA", n: "NVIDIA Corporation Common Stock", x: "NASDAQ" },
    { s: "NVDL", n: "GraniteShares 2x Long NVDA Daily ETF", x: "NASDAQ" },
    { s: "AAPL", n: "Apple Inc. Common Stock", x: "NASDAQ" },
    { s: "APLE", n: "Apple Hospitality REIT, Inc. Common Shares", x: "NYSE" },
    { s: "PLTR", n: "Palantir Technologies Inc. Class A Common Stock", x: "NASDAQ" },
    { s: "BRK.B", n: "Berkshire Hathaway Inc. Class B", x: "NYSE" },
    { s: "APPLX", n: "Applied Pink Sheet Co", x: "OTC" },
  ];
  it("matches tickers first, then company names", () => {
    expect(suggest(list, "nv").map((s) => s.symbol)).toEqual(["NVDA", "NVDL"]);
    expect(suggest(list, "nvidia")[0]).toEqual({ symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ" });
    expect(suggest(list, "apple").map((s) => s.symbol)).toEqual(["AAPL", "APLE"]);
    expect(suggest(list, "$pltr")[0].symbol).toBe("PLTR");
    expect(suggest(list, "palantir")[0].name).toBe("Palantir Technologies Inc.");
    expect(suggest(list, "brk-b")[0].symbol).toBe("BRK.B");
    expect(suggest(list, "")).toEqual([]);
  });
  it("a search for a name or part of a ticker resolves to the stock", () => {
    expect(resolveTyped(list, "Apple")).toBe("AAPL");
    expect(resolveTyped(list, "nvidia")).toBe("NVDA");
    expect(resolveTyped(list, "aple")).toBe("APLE");
    expect(resolveTyped([], "msft")).toBe("MSFT"); // no listing (Alpaca not set up): the text as a ticker
    expect(resolveTyped([], "microsoft corp")).toBeNull();
    expect(resolveTyped(list, "spacex")).toBeNull(); // not listed: the box offers to research it as a theme
    expect(resolveTyped(list, "zzzz")).toBeNull();
    expect(cleanName("Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share")).toBe("Alibaba Group Holding Limited");
  });
});
