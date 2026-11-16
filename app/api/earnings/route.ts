import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { query } from "@/lib/db";
import { getScan, markTapped, type EarnCard } from "@/lib/scout/earnings";
import * as store from "@/lib/scout/store";
import { sendIdeaToSwing } from "@/lib/scout/swing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Earnings tab: send one promoted A-setup to the Swing ideas log (paper, its "earnings" section). */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = z.object({ action: z.literal("send"), id: z.number().int().positive() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { action: 'send', id }"] }, { status: 422 });
  const s = await getScan(parsed.data.id);
  const t = (await query(`SELECT * FROM earnings_tracks WHERE scan_id = $1`, [parsed.data.id]))[0];
  const c = (await query(`SELECT card FROM earnings_cards WHERE scan_id = $1`, [parsed.data.id]))[0]?.card as EarnCard | undefined;
  if (!s || !t) return NextResponse.json({ ok: false, errors: ["no such setup"] }, { status: 404 });
  if (!(s.setup === "A" || s.setup === "A+" || s.setup === "A++")) return NextResponse.json({ ok: false, errors: ["only A setups can be sent (B and C are study only)"] }, { status: 422 });
  if (c?.ai_recommendation !== "promote") return NextResponse.json({ ok: false, errors: ["only promoted cards can be sent"] }, { status: 422 });
  if (t.tapped_at) return NextResponse.json({ ok: false, errors: ["already sent"] }, { status: 409 });
  if (t.closed) return NextResponse.json({ ok: false, errors: ["this paper track has already closed"] }, { status: 422 });
  const settings = await store.loadSettings();
  const exit = t.exit_date ? new Date(t.exit_date).toISOString().slice(0, 10) : null;
  const days = exit ? Math.max(1, Math.round((Date.parse(`${exit}T21:00:00Z`) - Date.now()) / 86400_000)) : 90;
  const speculative = (c?.confidence ?? 0) < 50;
  try {
    const r = await sendIdeaToSwing({
      ticker: s.symbol, side: "long", catalyst: "earnings", speculative, notional: speculative ? settings.swingSpeculativeSize : settings.swingSize, exitRule: "time", exitParam: Math.min(365, days),
      thesis: `[Trend scout earnings drift, setup ${s.setup}, reported ${s.reportDate}] EPS ${s.numbers.eps_actual} vs ${s.numbers.eps_consensus} consensus (rank ${s.numbers.surprise_pct_rank}); beat quality ${c.beat_quality}, guidance ${c.guidance}. ${c.thesis} Exit: ${c.exit_plan}.`.slice(0, 1000),
    });
    if (!r.ok) return NextResponse.json({ ok: false, errors: (r.body as { errors?: string[] }).errors ?? [`swing log replied ${r.status}`] }, { status: 422 });
    await markTapped(s.id, r.body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
