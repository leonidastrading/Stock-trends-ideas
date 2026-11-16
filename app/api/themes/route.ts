import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.union([
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("research"), run: z.number().int().positive(), index: z.number().int().min(0).max(2) }),
]);

/** Refresh today's themes now, or research one theme into a card (scores as "Scout · themes (consensus)"). */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { action: 'refresh' } or { action: 'research', run, index }"] }, { status: 422 });
  const deps = defaultDeps();
  const { runThemes, themeRuns } = await import("@/lib/scout/themes");
  try {
    if (parsed.data.action === "refresh") return NextResponse.json({ ok: true, result: await runThemes(deps) });
    const { run, index } = parsed.data;
    const r = (await themeRuns(60)).find((x) => x.id === run);
    const t = r?.themes[index];
    if (!r || !t) return NextResponse.json({ ok: false, errors: ["that theme is not on file"] }, { status: 404 });
    const { researchCandidate } = await import("@/lib/scout/research");
    const context = `A consensus theme the scout found on ${r.etDate} across the trader's sources (${t.agreement.documents} documents, ${t.agreement.websites} website articles, ${t.agreement.stocktwits} Stocktwits posts agree): ${t.title}.
Proposed: ${t.direction} ${t.tickers.join(", ")} for 1-2 weeks. Thesis: ${t.thesis}
Catalyst: ${t.catalyst}
What the sources say: ${t.quotes.map((x) => `"${x.text}" (${x.source})`).join("; ")}
Who disagrees: ${t.disagreement || "nobody in the sources"}
Crowding: ${t.crowding}
What would break it: ${t.breaks_it}
Consensus is not edge: check what is already priced (moves, coverage) and say plainly if the crowd is late. Time limit about 10 trading days unless a dated catalyst decides it sooner.`;
    const res = await researchCandidate({ origin: "scout", term: `theme: ${t.title.slice(0, 80)} → ${t.tickers[0]}`, kindHint: "event", tickersHint: t.tickers, observation: null, context, proposedDirection: t.direction }, deps);
    return res.outcome === "card" ? NextResponse.json({ ok: true, cardId: res.card.id, status: res.card.status }) : NextResponse.json({ ok: false, errors: [`${res.outcome}: ${res.reason}`] }, { status: 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
