import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Spreadsheet formula injection guard + CSV quoting. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of every card with its paper track. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const [cards, tracks] = await Promise.all([store.allCards(), store.allTracks()]);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const head = ["card_id", "created_at", "version", "origin", "kind", "status", "title", "direction", "ticker", "sector", "novelty", "materiality", "breadth", "lateness_score", "confidence", "rank", "move_30d_pct", "news_30d", "time_limit_days", "catalyst_date", "entry_date", "entry_price", "exit_date", "exit_price", "exit_reason", "spy_entry", "spy_exit", "sector_entry", "sector_exit", "max_drawdown_pct", "tapped_at", "gate_notes"];
  const rows = cards.map((c) => {
    const k = c.card;
    const x = t.get(c.id);
    return [c.id, c.createdAt, c.versionId, c.origin, c.kind, c.status, k.title, c.direction, c.primaryTicker, c.sector, k.scores.novelty, k.scores.materiality, k.scores.breadth_of_evidence, k.scores.lateness, k.confidence, c.rankScore, k.lateness.stock_move_30d_pct, k.lateness.news_stories_30d, c.timeLimitDays, c.catalystDate, x?.entryDate, x?.entryPrice, x?.exitDate, x?.exitPrice, x?.exitReason, x?.spyEntry, x?.spyExit, x?.sectorEntry, x?.sectorExit, x?.maxDrawdownPct, x?.tappedAt, c.gateNotes.join(" | ")].map(csvCell).join(",");
  });
  return new NextResponse([head.join(","), ...rows].join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="trend-scout-cards.csv"` } });
}
