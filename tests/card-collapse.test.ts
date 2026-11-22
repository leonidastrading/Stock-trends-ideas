import { describe, expect, it } from "vitest";
import { isCollapsed } from "@/components/CardCollapse";

describe("card folding", () => {
  it("a card's own choice wins; otherwise the remembered default (Collapse all / Expand all)", () => {
    expect(isCollapsed("12", new Set(["12"]), new Set(), false)).toBe(true);
    expect(isCollapsed("12", new Set(), new Set(["12"]), true)).toBe(false);
    expect(isCollapsed("99", new Set(), new Set(), true)).toBe(true);
    expect(isCollapsed("99", new Set(), new Set(), false)).toBe(false);
  });
});
