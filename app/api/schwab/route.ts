import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { shortData, shortText } from "@/lib/market/short";
import { disconnect, fundamentals } from "@/lib/sources/schwab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [z.object({ action: z.literal("test"), symbol: z.string().regex(/^[A-Z]{1,5}(\.[A-Z])?$/) }), z.object({ action: z.literal("disconnect") })]);

/** Settings: test the connection on one stock (short-interest numbers only), or disconnect. Never returns tokens. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["bad request"] }, { status: 422 });
  try {
    if (parsed.data.action === "disconnect") {
      await disconnect();
      return NextResponse.json({ ok: true });
    }
    const sym = parsed.data.symbol;
    const [f, sd] = await Promise.all([fundamentals([sym]).then((m) => m.get(sym) ?? null).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })), shortData([sym]).then((m) => m.get(sym) ?? null)]);
    const schwab = f && "error" in f ? { error: f.error } : f ? { shortFields: f.short.fields, shareFields: f.shareFields } : { error: `Schwab returned nothing for ${sym}` };
    return NextResponse.json({ ok: true, result: { symbol: sym, line: shortText(sd), nasdaq: sd, schwab } });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 502 });
  }
}
