import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ cardId: z.number().int().positive(), on: z.boolean() });

/** Star or unstar a card. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { cardId, on }"] }, { status: 422 });
  await store.setFavorite(parsed.data.cardId, parsed.data.on);
  return NextResponse.json({ ok: true, cardId: parsed.data.cardId, on: parsed.data.on });
}
