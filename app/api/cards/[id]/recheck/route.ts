import { NextResponse } from "next/server";
import { marketDataFromEnv } from "@/lib/alpaca";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { callResearchModel } from "@/lib/scout/llm";
import { recheckCard } from "@/lib/scout/recheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** "Still valid?": the scout re-checks a card against what happened since. Saved as its own row; the card is not changed. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, errors: ["bad card id"] }, { status: 400 });
  try {
    const { recheck, fresh } = await recheckCard(id, { data: marketDataFromEnv(), callModel: callResearchModel, now: new Date() });
    return NextResponse.json({ ok: true, recheck, fresh });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const friendly = msg === "capped" ? "today's AI budget is spent (raise the daily cap in Settings)" : /credit balance/i.test(msg) ? "the Anthropic account is out of credit" : msg === "card not found" ? msg : `the check failed: ${msg.slice(0, 160)}`;
    return NextResponse.json({ ok: false, errors: [friendly] }, { status: msg === "card not found" ? 404 : 200 });
  }
}
