import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { cleanSymbol, lookupTicker } from "@/lib/scout/lookup";
import { listings, resolveTyped, suggest } from "@/lib/scout/symbol-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ticker search: ?suggest=<typed> for the drop-down, ?symbol=<ticker or company name> for the result. */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const sp = new URL(request.url).searchParams;
  // ?cards=A,B → the scout's existing cards on those stocks (shown while a ticker is typed on the Research tab).
  if (sp.has("cards")) {
    const { cardsBySymbol, LIST_MAX, typedTickers } = await import("@/lib/scout/cards-on-file");
    const symbols = typedTickers(sp.get("cards") ?? "", LIST_MAX);
    const { cardsOnSymbols } = await import("@/lib/scout/store");
    const found = await cardsOnSymbols(symbols).catch(() => []);
    return NextResponse.json({ ok: true, cards: cardsBySymbol(found, symbols) });
  }
  // ?card=<number> → whether that card exists (the search box goes straight to it).
  if (sp.has("card")) {
    const { cardNumber } = await import("@/lib/scout/card-number");
    const id = cardNumber(sp.get("card") ?? "");
    const { getCard } = await import("@/lib/scout/store");
    const c = id ? await getCard(id).catch(() => null) : null;
    if (!c) return NextResponse.json({ ok: false, errors: [`there is no card #${id ?? sp.get("card")}`] }, { status: 404 });
    return NextResponse.json({ ok: true, card: { id: c.id, title: c.card.title, ticker: c.primaryTicker, direction: c.direction, status: c.status } });
  }
  const list = await listings().catch(() => []);
  // ?listed=A,B,C → which of these are real listed symbols (for colouring tickers in answers).
  if (sp.has("listed")) {
    const want = (sp.get("listed") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)).slice(0, 80);
    const known = new Set(list.map((l) => l.s));
    const listed = list.length ? want.filter((s) => known.has(s)) : [];
    const { latestCardIds } = await import("@/lib/scout/store");
    const cards = Object.fromEntries(await latestCardIds(want).catch(() => new Map<string, number>()));
    // A stock with a card counts as a ticker even when the stock list is not loaded.
    const names = Object.fromEntries(list.filter((l) => listed.includes(l.s)).map((l) => [l.s, l.n]));
    return NextResponse.json({ ok: true, listed: [...new Set([...listed, ...Object.keys(cards)])], cards, names });
  }
  if (sp.has("suggest")) return NextResponse.json({ ok: true, suggestions: suggest(list, sp.get("suggest") ?? "", 8) });
  const typed = (sp.get("symbol") ?? "").slice(0, 80);
  const symbol = cleanSymbol(resolveTyped(list, typed) ?? "");
  if (!symbol) return NextResponse.json({ ok: false, errors: [`no stock found for "${typed}"; try a ticker like NVDA or a company name like Nvidia`] }, { status: 422 });
  const result = await lookupTicker(symbol);
  const listed = list.find((l) => l.s === symbol);
  return NextResponse.json({ ok: true, result: { ...result, name: result.name ?? (listed ? suggest([listed], symbol, 1)[0]?.name ?? null : null) } });
}
