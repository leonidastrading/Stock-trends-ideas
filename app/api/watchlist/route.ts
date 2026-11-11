import { NextResponse } from "next/server";
import { z } from "zod";
import { KINDS } from "@/config/scout";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const add = z.object({ action: z.literal("add"), term: z.string().trim().min(2).max(80), kind: z.enum(KINDS), tickers: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/)).max(8) });
const status = z.object({ action: z.enum(["approve", "retire", "reactivate"]), id: z.number().int() });

export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const body = await request.json().catch(() => null);
  const a = add.safeParse(body);
  if (a.success) {
    const w = await store.addWatch({ ...a.data, addedBy: "vadim", status: "active" });
    return w ? NextResponse.json({ ok: true, item: w }) : NextResponse.json({ ok: false, errors: ["that term is already on the list"] }, { status: 409 });
  }
  const s = status.safeParse(body);
  if (s.success) {
    await store.setWatchStatus(s.data.id, s.data.action === "retire" ? "retired" : "active");
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, errors: [...a.error.issues, ...s.error.issues].map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
}
