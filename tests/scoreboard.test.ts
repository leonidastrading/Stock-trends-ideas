import { describe, expect, it } from "vitest";
import { brier, byKind, calibration, coinTail, playerOf, standings, toRound } from "@/lib/scout/scoreboard";
import type { IdeaResult } from "@/lib/scout/scoring";

const idea = (id: number, excess: number | null, closed = true, kind = "consumer"): IdeaResult => ({
  cardId: id, origin: "scout", tapped: false, kind, status: "promoted", rankScore: 50, symbol: `T${id}`, direction: "long", entryDate: "2026-11-02", exitDate: closed ? "2026-11-20" : null, closed,
  ret: excess ?? 0, spyRet: 0, sectorRet: 0, excess, excessSector: excess, maxDrawdownPct: -2, baseline: [],
});

describe("scoreboard", () => {
  it("tells the players apart by origin and term", () => {
    expect(playerOf("scout", "AI agents paying merchants")).toBe("scout_trend");
    expect(playerOf("scout", "story: CEO resigns → XYZ")).toBe("scout_story");
    expect(playerOf("human", "ATC upgrade")).toBe("you");
    expect(playerOf("human", "stream host: CRWV")).toBe("stream_host");
    expect(playerOf("human", "Stream Agent: ZM")).toBe("stream_agent");
    expect(playerOf("human", undefined)).toBe("you");
  });

  it("points are dollars beaten vs SPY on a $1,000 stake", () => {
    expect(toRound(idea(1, 0.032), "you", 70, true).points).toBe(32);
    expect(toRound(idea(2, -0.05), "you", 70, true)).toMatchObject({ points: -50, win: false });
    expect(toRound(idea(3, null), "you", 70, true)).toMatchObject({ points: null, win: null });
  });

  it("coin-flip tail probabilities", () => {
    expect(coinTail(0, 10)).toBeCloseTo(1, 10);
    expect(coinTail(10, 10)).toBeCloseTo(1 / 1024, 10);
    expect(coinTail(8, 10)).toBeCloseTo(56 / 1024, 10);
    expect(coinTail(60, 100)).toBeCloseTo(0.0284, 3);
  });

  it("standings bank closed points, keep open ones in play, rank by banked", () => {
    const rounds = [
      toRound(idea(1, 0.04), "you", 70, true), toRound(idea(2, -0.01), "you", 60, true), toRound(idea(3, 0.1, false), "you", 80, true),
      toRound(idea(4, 0.01), "scout_trend", 55, true),
    ];
    const s = standings(rounds);
    expect(s[0]).toMatchObject({ player: "you", banked: 30, inPlay: 100, wins: 1, closed: 2, open: 1, hitRate: 0.5 });
    expect(s[0].best?.cardId).toBe(1);
    expect(s[0].worst?.cardId).toBe(2);
    expect(s[1]).toMatchObject({ player: "scout_trend", banked: 10, worst: null });
    expect(s.find((x) => x.player === "stream_host")).toMatchObject({ calls: 0, hitRate: null, luck: null });
  });

  it("calibration and Brier count only closed calls from calibrated versions", () => {
    const rounds = [
      toRound(idea(1, 0.02), "you", 72, true), toRound(idea(2, -0.02), "you", 75, true), toRound(idea(3, 0.03), "you", 78, true),
      toRound(idea(4, 0.05), "you", 90, false), // old version: confidence was undefined
      toRound(idea(5, 0.05, false), "you", 90, true), // still open
    ];
    const seventies = calibration(rounds).find((b) => b.label === "70–79")!;
    expect(seventies.n).toBe(3);
    expect(seventies.said).toBeCloseTo(0.75, 5);
    expect(seventies.hit).toBeCloseTo(2 / 3, 5);
    expect(calibration(rounds).find((b) => b.label === "80 and up")!.n).toBe(0);
    const b = brier(rounds);
    expect(b.n).toBe(3);
    expect(b.score).toBeCloseTo(((0.72 - 1) ** 2 + 0.75 ** 2 + (0.78 - 1) ** 2) / 3, 6);
  });

  it("wins by kind and player", () => {
    const k = byKind([toRound(idea(1, 0.02, true, "event"), "scout_story", 60, true), toRound(idea(2, -0.03, true, "event"), "scout_story", 60, true), toRound(idea(3, 0.5, false, "event"), "scout_story", 60, true)]);
    expect(k.event.scout_story).toEqual({ wins: 1, closed: 2, points: -10 });
  });
});

describe("calibrated versions", () => {
  it("finds the versions whose schema defines confidence as a probability", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { setQuerierForTests } = await import("@/lib/db");
    const store = await import("@/lib/scout/store");
    const { versionSpec, versionHash } = await import("@/lib/scout/version");
    const pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
    try {
      const old = await store.ensureVersion("old", "m", "high", { replySchema: { confidence: { description: "0-100" } } });
      const spec = versionSpec("m", "high");
      const now = await store.ensureVersion(versionHash(spec), "m", "high", spec);
      const ids = await store.calibratedVersionIds();
      expect(ids.has(now.id)).toBe(true);
      expect(ids.has(old.id)).toBe(false);
    } finally {
      setQuerierForTests(null);
    }
  });
});
