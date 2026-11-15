import { describe, expect, it } from "vitest";
import { hrefWith, paginate } from "@/components/Pager";

describe("paging", () => {
  it("slices pages and clamps out-of-range pages", () => {
    const xs = Array.from({ length: 23 }, (_, i) => i);
    expect(paginate(xs, 1, 10)).toMatchObject({ items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], page: 1, pages: 3, total: 23 });
    expect(paginate(xs, 3, 10).items).toEqual([20, 21, 22]);
    expect(paginate(xs, 99, 10).page).toBe(3);
    expect(paginate(xs, Number("x"), 10).page).toBe(1);
    expect(paginate([], 1, 10)).toMatchObject({ items: [], page: 1, pages: 1, total: 0 });
  });

  it("links keep the other filters and drop cleared ones", () => {
    expect(hrefWith({ days: "30", outcome: "late", lpage: "3" }, { lpage: "4" }, "#log")).toBe("?days=30&outcome=late&lpage=4#log");
    expect(hrefWith({ days: "30", outcome: "late", lpage: "3" }, { outcome: undefined, lpage: undefined })).toBe("?days=30");
  });
});
