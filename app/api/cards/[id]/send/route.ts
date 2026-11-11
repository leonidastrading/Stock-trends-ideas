import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import { sendToSwing, swingConfigured } from "@/lib/scout/swing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One tap: send a card to the Swing ideas log as a paper idea. Recorded here either way. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(_request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  if (!swingConfigured()) return NextResponse.json({ ok: false, errors: ["Set SWING_API_URL, SWING_API_USER and SWING_API_PASSWORD (the Swing ideas app's address and dashboard login) and redeploy."] }, { status: 503 });
  const id = Number((await ctx.params).id);
  const card = await store.getCard(id);
  if (!card) return NextResponse.json({ ok: false, errors: ["no such card"] }, { status: 404 });
  if (card.status === "not_promoted") return NextResponse.json({ ok: false, errors: ["this card failed the materiality gate and is not tracked; it can't be sent"] }, { status: 422 });
  const track = await store.getTrack(id);
  if (track?.tappedAt) return NextResponse.json({ ok: false, errors: [`already sent on ${track.tappedAt.slice(0, 10)}`] }, { status: 409 });
  try {
    const r = await sendToSwing(card);
    if (r.ok) {
      await store.setTapped(id, r.body);
      await store.addTrackEvent(id, "sent_to_swing", JSON.stringify(r.body).slice(0, 500));
      return NextResponse.json({ ok: true, swing: r.body });
    }
    await store.addTrackEvent(id, "send_failed", JSON.stringify(r.body).slice(0, 500));
    const errors = (r.body as { errors?: string[] }).errors ?? [`swing log replied ${r.status}`];
    return NextResponse.json({ ok: false, errors }, { status: 422 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.addTrackEvent(id, "send_failed", message.slice(0, 500));
    return NextResponse.json({ ok: false, errors: [message] }, { status: 500 });
  }
}
