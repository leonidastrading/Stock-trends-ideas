import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vadim marks the card's invalidation as met: the paper track exits at the next open. Append-only event. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const id = Number((await ctx.params).id);
  const track = await store.getTrack(id);
  if (!track) return NextResponse.json({ ok: false, errors: ["this card has no paper track"] }, { status: 404 });
  if (track.exitDate) return NextResponse.json({ ok: false, errors: ["track already closed"] }, { status: 409 });
  const body = (await request.json().catch(() => ({}))) as { note?: string };
  await store.addTrackEvent(id, "invalidated", (body.note ?? "").slice(0, 500) || null);
  return NextResponse.json({ ok: true });
}
