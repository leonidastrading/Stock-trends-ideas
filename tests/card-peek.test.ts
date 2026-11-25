import { describe, expect, it } from "vitest";
import { logPieces, slim } from "../lib/scout/card-peek";

describe("cards written to the log for a coding session", () => {
  it("cuts a long card into numbered pieces that join back to the whole", () => {
    const text = "x".repeat(7000) + "END";
    const pieces = logPieces("card-peek #363", text, 3000);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toMatch(/^card-peek #363 \[1\/3\] x+$/);
    expect(pieces.map((p) => p.replace(/^card-peek #363 \[\d\/3\] /, "")).join("")).toBe(text);
    expect(logPieces("c", "short")).toEqual(["c [1/1] short"]);
  });
  it("drops empty fields and links, at any depth", () => {
    expect(slim({ id: 1, title: "t", url: "https://x", note: null, empty: "", card: { thesis: "th", links: ["a"], tickers: [{ symbol: "GPN", logo: "l", why: "w" }] } })).toEqual({ id: 1, title: "t", card: { thesis: "th", tickers: [{ symbol: "GPN", why: "w" }] } });
  });
});
