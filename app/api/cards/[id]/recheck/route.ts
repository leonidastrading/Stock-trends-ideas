import { after, NextResponse } from "next/server";
import { marketDataFromEnv } from "@/lib/alpaca";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { callResearchModel } from "@/lib/scout/llm";
import { RECHECK_EVERY_MIN, recheckStatus, runRecheck } from "@/lib/scout/recheck";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const cardId = async (ctx: { params: Promise<{ id: string }> }) => { const id = Number((await ctx.params).id); return Number.isInteger(id) && id > 0 ? id : null; };

/**
 * "Still valid?": the scout re-checks a card against what happened since. The check is started here and runs to the
 * end on the server whether or not the page stays open (about a minute); the answer is saved as its own row and shown
 * on the card. The card is not changed. Answers at once: the last answer when it is under 15 minutes old, else "started".
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const id = await cardId(ctx);
  if (!id) return NextResponse.json({ ok: false, errors: ["bad card id"] }, { status: 400 });
  if (!(await store.getCard(id).catch(() => null))) return NextResponse.json({ ok: false, errors: ["card not found"] }, { status: 404 });
  const now = new Date();
  const st = await recheckStatus(id, now);
  if (st.recheck && now.getTime() - Date.parse(st.recheck.checkedAt) < RECHECK_EVERY_MIN * 60_000) return NextResponse.json({ ok: true, recheck: st.recheck, fresh: false });
  if (st.runningSince) return NextResponse.json({ ok: true, started: true, runningSince: st.runningSince }, { status: 202 });
  after(() => runRecheck(id, { data: marketDataFromEnv(), callModel: callResearchModel, now }));
  return NextResponse.json({ ok: true, started: true, runningSince: now.toISOString() }, { status: 202 });
}

/** Where the card's check stands: the last answer, whether one is running, and the last failure. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const id = await cardId(ctx);
  if (!id) return NextResponse.json({ ok: false, errors: ["bad card id"] }, { status: 400 });
  return NextResponse.json({ ok: true, ...(await recheckStatus(id)) });
}
