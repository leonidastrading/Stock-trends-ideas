import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { researchDrift, type DriftSetup } from "@/lib/scout/drift";
import { defaultDeps } from "@/lib/scout/engine";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Drift page: research one listed setup now (scores as the down-drift desk). */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = z.object({ symbol: z.string().regex(/^[A-Z]{1,5}(\.[A-Z])?$/) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { symbol }"] }, { status: 422 });
  const setup = (await store.cacheGet<{ setups: DriftSetup[] }>("drift"))?.data?.setups?.find((s) => s.symbol === parsed.data.symbol);
  if (!setup) return NextResponse.json({ ok: false, errors: [`${parsed.data.symbol} is no longer on the drift list`] }, { status: 404 });
  try {
    const r = await researchDrift(defaultDeps(), setup);
    return r.cardId ? NextResponse.json({ ok: true, cardId: r.cardId, status: r.status }) : NextResponse.json({ ok: false, errors: [`${r.outcome}${r.reason ? `: ${r.reason}` : ""}`] }, { status: 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
