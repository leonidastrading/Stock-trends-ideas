import { NextResponse } from "next/server";
import { tradingViewUrl } from "@/config/links";
import { listings } from "@/lib/scout/symbol-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A ticker link: look up the stock's US exchange and open TradingView on exactly that listing. */
export async function GET(_request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const sym = decodeURIComponent((await ctx.params).symbol).replace(/^\$/, "").toUpperCase().slice(0, 12);
  const listing = (await listings().catch(() => [])).find((l) => l.s === sym);
  return NextResponse.redirect(tradingViewUrl(sym, listing?.x ?? null), 302);
}
