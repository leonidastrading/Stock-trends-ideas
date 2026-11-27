import { describe, expect, it } from "vitest";
import { daytradeBoard, rankMove, type DtItem, type DtSnap } from "@/lib/scout/daytrade";

const item = (rank: number, symbol: string, price: number | null = 10): DtItem => ({ rank, symbol, name: symbol, exchange: "NASDAQ", watchers: 1000, score: 1, summary: null, price, prevClose: 9 });
const snap = (id: number, takenAt: string, items: DtItem[]): DtSnap => ({ id, takenAt, items });

describe("daytrade board", () => {
  it("is empty without readings", () => {
    expect(daytradeBoard([])).toEqual({ latest: null, readsToday: 0, rows: [], gone: [] });
  });

  it("tracks each name's history on the latest reading's New York day", () => {
    const b = daytradeBoard([
      // The evening before (New York): not part of today.
      snap(1, "2026-11-26T23:00:00Z", [item(1, "OLD"), item(2, "TSLA", 380)]),
      snap(2, "2026-11-27T14:30:00Z", [item(1, "TSLA", 390), item(2, "MO", 76), item(3, "COST", null)]),
      snap(3, "2026-11-27T14:35:00Z", [item(1, "TSLA", 392), item(2, "COST", 1090), item(3, "VRTX", 530)]),
      snap(4, "2026-11-27T14:40:00Z", [item(1, "COST", 1094), item(2, "TSLA", 399), item(3, "PATH", 12.7)]),
    ]);
    expect(b.readsToday).toBe(3);
    expect(b.rows.map((r) => r.symbol)).toEqual(["COST", "TSLA", "PATH"]);
    const [cost, tsla, path] = b.rows;
    // No price at the first reading: the first reading with one stands in.
    expect(cost).toMatchObject({ rankBefore: 2, firstSeen: "2026-11-27T14:30:00Z", firstPrice: 1090, bestRank: 1, reads: 3 });
    expect(tsla).toMatchObject({ rankBefore: 1, firstPrice: 390, bestRank: 1, reads: 3 });
    expect(path).toMatchObject({ rankBefore: null, firstSeen: "2026-11-27T14:40:00Z", reads: 1 });
    // Dropped off today, latest first; yesterday's names are not listed.
    expect(b.gone.map((g) => g.symbol)).toEqual(["VRTX", "MO"]);
    expect(b.gone[1]).toMatchObject({ firstPrice: 76, bestRank: 2, reads: 1, lastSeen: "2026-11-27T14:30:00Z" });
  });

  it("takes readings in any order", () => {
    const b = daytradeBoard([snap(2, "2026-11-27T14:35:00Z", [item(1, "B")]), snap(1, "2026-11-27T14:30:00Z", [item(1, "A")])]);
    expect(b.latest?.id).toBe(2);
    expect(b.gone.map((g) => g.symbol)).toEqual(["A"]);
  });
});

describe("rank move", () => {
  it("says new, up, down or nothing", () => {
    expect(rankMove(1, null, true)).toEqual({ text: "new", dir: "new" });
    expect(rankMove(1, 3, true)).toEqual({ text: "▲2", dir: "up" });
    expect(rankMove(4, 3, true)).toEqual({ text: "▼1", dir: "down" });
    expect(rankMove(2, 2, true)).toEqual({ text: "", dir: "same" });
    // The very first reading has nothing to compare with.
    expect(rankMove(1, null, false)).toEqual({ text: "", dir: "same" });
  });
});
