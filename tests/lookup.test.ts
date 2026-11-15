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
