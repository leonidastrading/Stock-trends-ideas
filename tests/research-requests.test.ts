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

import { fromCandidates } from "@/lib/scout/research-requests";
import type { Candidate } from "@/lib/scout/store";

describe("research from before requests were logged", () => {
  it("lists your own earlier research (not your bots' or the scout's), only from before the log started", () => {
    const c = (id: number, createdAt: string, origin: "human" | "scout", sourceLabel: string | null, outcome: Candidate["outcome"] = "card") => ({ id, createdAt, origin, sourceLabel, sourceUrl: "/", term: `t${id}`, tickersHint: ["MU"], outcome, reason: outcome === "card" ? null : "already priced", cardId: outcome === "card" ? 300 + id : null }) as Candidate;
    const rows = fromCandidates([c(1, "2026-11-22T20:29:00Z", "human", "Your note"), c(2, "2026-11-22T20:10:00Z", "human", null), c(3, "2026-11-22T20:00:00Z", "scout", "Themes"), c(4, "2026-11-22T20:50:00Z", "human", "News"), c(5, "2026-11-22T19:00:00Z", "human", "Court", "rejected")], "2026-11-22T20:47:00Z");
    expect(rows.map((r) => [r.id, r.status, r.cardId, r.reason])).toEqual([[-1, "card", 301, null], [-5, "rejected", null, "already priced"]]);
  });
});
