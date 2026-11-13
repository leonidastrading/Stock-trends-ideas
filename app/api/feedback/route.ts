import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  target: z.string().regex(/^(card:\d+|story:[^\s]{1,80})$/),
  vote: z.enum(["up", "down"]),
  note: z.string().trim().max(500).optional(),
});

/** Thumbs up or down on a card or a story, with an optional note. Append-only; the latest counts. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  await store.addFeedback(parsed.data.target, parsed.data.vote, parsed.data.note || null);
  return NextResponse.json({ ok: true });
}
