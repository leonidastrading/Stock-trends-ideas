import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { disconnect, shortInterest, squeezeRisk } from "@/lib/sources/schwab";

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
    const s = (await shortInterest([parsed.data.symbol])).get(parsed.data.symbol);
    if (!s) return NextResponse.json({ ok: false, errors: [`Schwab returned nothing for ${parsed.data.symbol}`] }, { status: 404 });
    return NextResponse.json({ ok: true, result: { ...s, squeeze: squeezeRisk(s) } });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 502 });
  }
}
