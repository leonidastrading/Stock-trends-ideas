import { NextResponse } from "next/server";
import { hasDatabase, query } from "@/lib/db";
import { bearerOk, cardForApi } from "@/lib/scout/card-api";
import { crowdingFor } from "@/lib/scout/crowding";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only: one card as JSON for an outside dashboard. Only "Authorization: Bearer <SCOUT_API_TOKEN>" is accepted
 * (the site login is not); the proxy lets exactly GET/HEAD /api/cards/<id> through to this check.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Two read-only tokens: the oo-trading dashboard's, and a second one Vadim had created for card lookups in his coding sessions.
  const auth = request.headers.get("authorization");
  if (!bearerOk(auth, process.env.SCOUT_API_TOKEN) && !bearerOk(auth, process.env.SCOUT_READ_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="trend-scout"', "Cache-Control": "no-store" } });
  }
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const id = Number((await ctx.params).id);
  const card = Number.isInteger(id) && id > 0 ? await store.getCard(id) : null;
  if (!card) return NextResponse.json({ error: "no such card" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const [track, crowd] = await Promise.all([store.getTrack(id).catch(() => null), crowdingFor([id]).then((m) => m.get(id) ?? null).catch(() => null)]);
  // The readings' days in full (the shared reader keeps only the first ten characters of the driver's date).
  const days = await query(`SELECT kind, measured_on::text AS day FROM card_crowding WHERE card_id = $1 ORDER BY measured_on`, [id]).catch(() => []);
  for (const d of days) { const r = d.kind === "entry" ? crowd?.entry : crowd?.latest; if (r) r.measuredOn = String(d.day); }
  return NextResponse.json(cardForApi(card, track, crowd, new URL(request.url).origin), { headers: { "Cache-Control": "no-store" } });
}
