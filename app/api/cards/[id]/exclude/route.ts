import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The paper track followed the wrong security (a reused ticker, e.g. SATS after EchoStar became ECHO):
 * leave it out of every score. The card itself is never edited; this is an append-only event with the reason.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const id = Number((await ctx.params).id);
  const track = await store.getTrack(id);
  if (!track) return NextResponse.json({ ok: false, errors: ["this card has no paper track"] }, { status: 404 });
  if (track.excluded) return NextResponse.json({ ok: false, errors: ["already excluded"] }, { status: 409 });
  const body = (await request.json().catch(() => ({}))) as { note?: string };
  const note = (body.note ?? "").trim().slice(0, 500);
  if (!note) return NextResponse.json({ ok: false, errors: ["say what the ticker actually is"] }, { status: 422 });
  await store.addTrackEvent(id, "excluded", `by Vadim: ${note}`);
  return NextResponse.json({ ok: true });
}
