import { NextResponse } from "next/server";
import { z } from "zod";
import { KINDS } from "@/config/scout";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps } from "@/lib/scout/engine";
import { researchCandidate } from "@/lib/scout/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  observation: z.string().trim().min(5).max(2000),
  term: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(KINDS).nullable().optional(),
  tickers: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/)).max(5).optional(),
});

/** "I noticed something": research Vadim's observation now and return the card (human-originated). */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  const { observation, term, kind, tickers } = parsed.data;
  try {
    const r = await researchCandidate(
      { origin: "human", term: term || observation.split(/[.!?\n]/)[0].slice(0, 80), kindHint: kind ?? null, tickersHint: tickers ?? [], observation },
      defaultDeps(),
    );
    if (r.outcome === "card") return NextResponse.json({ ok: true, cardId: r.card.id, status: r.card.status });
    return NextResponse.json({ ok: false, outcome: r.outcome, errors: [r.reason] }, { status: 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
