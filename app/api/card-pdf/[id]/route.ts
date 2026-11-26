import { NextResponse } from "next/server";
import { marketDataFromEnv } from "@/lib/alpaca";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { cardPdf, cardPdfName } from "@/lib/scout/card-pdf";
import { companyAbout } from "@/lib/scout/company-line";
import { paperResult, vsSpy } from "@/lib/scout/paper-result";
import * as store from "@/lib/scout/store";
import { addDays, toEt } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SECTOR_LABEL: Record<string, string> = { technology: "Technology", communication: "Communication services", consumer_discretionary: "Consumer discretionary", consumer_staples: "Consumer staples", health_care: "Health care", financials: "Financials", industrials: "Industrials", energy: "Energy", materials: "Materials", utilities: "Utilities", real_estate: "Real estate" };

/** One card as a PDF download (behind the site login, like the card page itself). */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ error: "database not connected" }, { status: 503 });
  const id = Number((await ctx.params).id);
  const card = Number.isInteger(id) && id > 0 ? await store.getCard(id).catch(() => null) : null;
  if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });
  const now = new Date(), today = toEt(now).date;
  const data = marketDataFromEnv();
  const [track, review, about, info, src, bars] = await Promise.all([
    store.getTrack(id).catch(() => null), store.getReview(id).catch(() => null), companyAbout(card.primaryTicker).catch(() => null),
    store.symbolInfo([card.primaryTicker]).then((m) => m.get(card.primaryTicker) ?? null).catch(() => null), store.cardSource(id).catch(() => null),
    // About eight months of closes, and SPY's for the comparison; the PDF is made without them when prices are not at hand.
    data ? data.getDailyBars([card.primaryTicker, "SPY"], addDays(today, -240), today, { feed: "sip", adjustment: "all" }).catch(() => []) : Promise.resolve([]),
  ]);
  const of = (sym: string) => bars.filter((b) => b.symbol === sym).sort((a, b) => a.date.localeCompare(b.date));
  const mine = of(card.primaryTicker), spy = of("SPY");
  const r = track ? paperResult(track, mine.at(-1)?.c ?? null, spy.at(-1)?.c ?? null, now) : null;
  const from = (await import("@/lib/scout/origin-tag")).originLink(card.origin, src?.term, src?.observation, src ? { label: src.sourceLabel, url: src.sourceUrl } : null);
  const pdf = await cardPdf({
    card, track, review, about: about?.about ?? null, sectorLabel: SECTOR_LABEL[card.sector] ?? card.sector.replace(/_/g, " "), companyName: info?.name ?? null, source: from.tag,
    bars: mine.map((b) => ({ date: b.date, c: b.c })), result: r ? { ...r, vsSpy: vsSpy(card.direction, r) } : null,
    siteUrl: process.env.DASHBOARD_URL?.replace(/\/$/, "") ?? new URL(request.url).origin, now,
  });
  return new NextResponse(Buffer.from(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${cardPdfName(card)}"`, "cache-control": "no-store" } });
}
