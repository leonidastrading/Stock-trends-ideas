import { after, NextResponse } from "next/server";
import { z } from "zod";
import { KINDS } from "@/config/scout";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps, runImportJob } from "@/lib/scout/engine";
import { researchCandidate } from "@/lib/scout/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Longer than this, the text is treated as a pasted page or article: the ideas are pulled out of it first. */
const PASTE_CHARS = 1500;

const schema = z.object({
  observation: z.string().trim().min(5).max(200_000),
  term: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(KINDS).nullable().optional(),
  tickers: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/)).max(5).optional(),
});

/**
 * "I noticed something": research Vadim's observation now and return the card (human-originated).
 * A long paste (a whole page or article) is read for ideas first, like an inbox document; each idea is then
 * researched in the background and scored as Vadim's.
 */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  const { observation, term, kind, tickers } = parsed.data;
  try {
    if (observation.length > PASTE_CHARS) {
      const deps = defaultDeps();
      const { ideasFrom } = await import("@/lib/scout/inbox");
      const { items } = await ideasFrom(observation, "text pasted into I noticed something", deps);
      if (!items.length) return NextResponse.json({ ok: false, errors: ["No tradeable ideas found in the pasted text. Add a sentence saying what you noticed, or name the tickers."] }, { status: 422 });
      const mine = items.slice(0, 12).map((it) => ({ ...it, source: "you" as const, kind: kind ?? it.kind, tickers: tickers?.length ? [...new Set([...tickers, ...it.tickers])].slice(0, 8) : it.tickers }));
      const label = `pasted ${new Date().toISOString().slice(0, 10)}`;
      after(async () => {
        await runImportJob(mine, label).catch((err) => console.error(`pasted import failed: ${err instanceof Error ? err.message : String(err)}`));
      });
      return NextResponse.json({ ok: true, extracted: mine.map((m) => ({ term: m.term, tickers: m.tickers, direction: m.direction ?? null })) }, { status: 202 });
    }
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
