import { describe, expect, it } from "vitest";
import { isStale, requestOutcome, type ResearchRequest } from "@/lib/scout/research-requests";

describe("research you asked for", () => {
  it("records a card, a rejection or an error", () => {
    expect(requestOutcome({ outcome: "card", cardId: 12, status: "promoted" })).toEqual({ status: "card", cardId: 12, cardStatus: "promoted", reason: null });
    expect(requestOutcome({ outcome: "rejected", reason: "already priced" })).toEqual({ status: "rejected", cardId: null, cardStatus: null, reason: "rejected: already priced" });
    expect(requestOutcome({ outcome: "capped", reason: "daily cap" }).status).toBe("error");
    expect(requestOutcome({ error: "boom" })).toEqual({ status: "error", cardId: null, cardStatus: null, reason: "boom" });
  });

  it("a request still running well past the server's time limit is shown as not finished", () => {
    const r = { status: "running", createdAt: "2026-11-22T20:00:00Z" } as ResearchRequest;
    expect(isStale(r, new Date("2026-11-22T20:05:00Z"))).toBe(false);
    expect(isStale(r, new Date("2026-11-22T20:09:00Z"))).toBe(true);
    expect(isStale({ ...r, status: "card" }, new Date("2026-11-22T21:00:00Z"))).toBe(false);
  });
});
