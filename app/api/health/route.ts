import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!hasDatabase()) return NextResponse.json({ ok: false, error: "database not connected" }, { status: 503 });
    const [daily, track, health] = await Promise.all([store.lastRun("daily"), store.lastRun("track"), store.allHealth()]);
    return NextResponse.json({
      ok: true,
      mode: "paper only: suggests and records, never places an order",
      last_daily_run: daily,
      last_track_run: track,
      sources: Object.fromEntries(health.map((h) => [h.source, h.status])),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
