import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps } from "@/lib/scout/engine";
import { getInvestigation, researchExposure, resetInvestigation, runInvestigation, startInvestigation } from "@/lib/scout/investigate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.union([
  z.object({ action: z.literal("research"), id: z.number().int().positive(), ticker: z.string().regex(/^[A-Z]{1,5}(\.[A-Z])?$/) }),
  z.object({ action: z.literal("retry"), id: z.number().int().positive() }),
  z.object({ text: z.string().max(300_000).default(""), url: z.string().max(1000).optional() }),
]);

/** Start an investigation (story text and/or an article link; runs in the background), or research one listed exposure. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { text, url } or { action: 'research', id, ticker }"] }, { status: 422 });
  const b = parsed.data;
  if ("action" in b && b.action === "retry") {
    if (!(await resetInvestigation(b.id))) return NextResponse.json({ ok: false, errors: ["only a failed investigation can be run again"] }, { status: 409 });
    after(() => runInvestigation(b.id, defaultDeps()).catch((err) => console.error(`investigation ${b.id} failed: ${err instanceof Error ? err.message : String(err)}`)));
    return NextResponse.json({ ok: true, id: b.id }, { status: 202 });
  }
  if ("action" in b) {
    const inv = await getInvestigation(b.id);
    if (!inv?.report) return NextResponse.json({ ok: false, errors: ["that investigation has no report"] }, { status: 404 });
    try {
      const { tracked } = await import("@/lib/scout/research-requests");
      const r = await tracked({ term: `${b.ticker} from investigation #${inv.id}`, tickers: [b.ticker], from: { label: "Investigate", url: `/investigate#inv-${inv.id}` } }, () => researchExposure(defaultDeps(), inv, b.ticker));
      return r.cardId ? NextResponse.json({ ok: true, cardId: r.cardId, status: r.status }) : NextResponse.json({ ok: false, errors: [`${r.outcome}${r.reason ? `: ${r.reason}` : ""}`] }, { status: 422 });
    } catch (err) {
      return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
    }
  }
  let text = b.text.trim();
  const url = b.url?.trim();
  if (url) {
    if (/youtube\.com|youtu\.be|rumble\.com|tiktok\.com/i.test(url)) {
      if (!text) return NextResponse.json({ ok: false, errors: ["Video sites block automated readers. Open the video's transcript (YouTube: … → Show transcript), copy it and paste it here."] }, { status: 422 });
    } else {
      const { articleText, cleanSiteUrl } = await import("@/lib/sources/site");
      const clean = cleanSiteUrl(url);
      if (!clean) return NextResponse.json({ ok: false, errors: ["that is not a public web address"] }, { status: 422 });
      const page = await articleText(clean, 30_000);
      if (!page && !text) return NextResponse.json({ ok: false, errors: ["Could not read that page (it may block automated readers or need a login). Paste its text instead."] }, { status: 422 });
      text = [text, page ? `Article (${clean}):\n${page}` : ""].filter(Boolean).join("\n\n");
    }
    text = `Link: ${url}\n\n${text}`;
  }
  if (text.length < 2) return NextResponse.json({ ok: false, errors: ["type a ticker, a name or a question, paste a story, or give a link"] }, { status: 422 });
  // A listed ticker typed alone (or with $) is the stock: say so, with its name and the scout's latest card.
  const stock = !url && text.length <= 12 ? await stockFor(text) : null;
  if (stock) text = stock;
  // Just a name or a short question: ask the scout to work out what it is first.
  else if (text.length < 80 && !url) text = `Investigate "${text}". It may be a ticker, a company, a person, a program or a topic: work out what it most likely is (say if it is ambiguous, e.g. a ticker that is also a foreign listing or an acronym), then follow the money around it: federal contracts, lobbying, PAC and campaign money, and the listed companies exposed.`;
  const id = await startInvestigation(text);
  after(() => runInvestigation(id, defaultDeps()).catch((err) => console.error(`investigation ${id} failed: ${err instanceof Error ? err.message : String(err)}`)));
  return NextResponse.json({ ok: true, id }, { status: 202 });
}

/** The investigation brief for a typed ticker that is a listed stock, or null. */
async function stockFor(typed: string): Promise<string | null> {
  const sym = typed.trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(sym)) return null;
  const { listings } = await import("@/lib/scout/symbol-search");
  const store = await import("@/lib/scout/store");
  const [list, cards] = await Promise.all([listings().catch(() => []), store.cardsForSymbol(sym, 1).catch(() => [])]);
  const listing = list.find((l) => l.s === sym);
  if (!listing && !cards.length) return null;
  const card = cards[0];
  return [
    `Investigate the stock ${sym}${listing ? ` (${listing.n}, ${listing.x})` : ""}. The user means this listed company, not an acronym or anything else with the same letters.`,
    card ? `The scout's latest card on it (#${card.id}, ${card.createdAt.slice(0, 10)}): ${card.title}. ${card.card.observation.slice(0, 1500)}` : "",
    `Follow the money around this company: who its customers and backers are, federal contracts and grants it or its customers get, lobbying and PAC money around its business, its large holders and insiders, and the listed companies exposed to it (suppliers, customers, competitors).`,
  ].filter(Boolean).join("\n\n");
}
