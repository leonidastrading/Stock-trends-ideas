import { marketDataFromEnv } from "@/lib/alpaca";
import { ATTACHED, CARD_ATTACHED, shownUserText } from "@/lib/scout/chat-text";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { buildBriefing, CHAT_MAX_CHARS, cardQuestion, chatTurn } from "@/lib/scout/chat";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({ thread: z.number().int().positive().optional(), cardId: z.number().int().positive().optional(), fromCard: z.boolean().optional(), message: z.string().trim().min(1).max(CHAT_MAX_CHARS, `That message is too long (over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters). Split it into parts.`) });

/** A thread's messages (for reloading the page). */
export async function GET(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = Number(new URL(request.url).searchParams.get("thread"));
  const t = id > 0 ? await store.getChatThread(id) : null;
  if (!t) return NextResponse.json({ ok: false, errors: ["no such chat"] }, { status: 404 });
  return NextResponse.json({ ok: true, thread: t.id, createdAt: t.createdAt, briefingChars: t.briefing.length, messages: t.messages });
}

/** Send a message; the reply streams back as plain text. A new chat starts from a fresh briefing. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => i.message) }, { status: 422 });
  let thread = parsed.data.thread ? await store.getChatThread(parsed.data.thread) : null;
  // A question asked from a card or rumor starts a fresh chat when the open one's data is over 12 hours old.
  if (thread && (parsed.data.cardId || parsed.data.fromCard) && Date.now() - Date.parse(thread.createdAt) > 12 * 3600_000) thread = null;
  if (!thread) {
    const id = await store.createChatThread(await buildBriefing());
    thread = (await store.getChatThread(id))!;
  }
  const t = thread;
  // Asked from a card: the whole card and its paper track go with the question (and stay in the chat's history).
  let message = parsed.data.message;
  let symbols: string[] = [];
  if (parsed.data.cardId) {
    const card = await store.getCard(parsed.data.cardId);
    if (!card) return NextResponse.json({ ok: false, errors: [`no card #${parsed.data.cardId}`] }, { status: 404 });
    message = cardQuestion(card, await store.getTrack(card.id).catch(() => null), message);
    symbols = [card.primaryTicker, ...card.card.tickers.map((x) => x.symbol)];
  } else {
    const asked = shownUserText(parsed.data.message);
    // Cards named in the question (#208, "card 208"): fetched now, so cards newer than the chat's briefing are seen.
    const { cardRefs } = await import("@/lib/scout/live-context");
    // A follow-up that names no card ("can you see it now?") reuses the card numbers of your last two messages.
    let refs = cardRefs(asked);
    if (!refs.length && asked.length < 200) refs = cardRefs(t.messages.filter((m) => m.role === "user").slice(-2).map((m) => shownUserText(m.content)).join(" "));
    if (refs.length) {
      const cards = await Promise.all(refs.map((id) => store.getCard(id).catch(() => null)));
      const parts: string[] = [];
      for (const [i, c] of cards.entries()) {
        if (!c) { parts.push(`No card numbered #${refs[i]} exists.`); continue; }
        symbols.push(c.primaryTicker);
        parts.push(`Card #${c.id}, fetched now:\n${cardQuestion(c, await store.getTrack(c.id).catch(() => null), "").split(CARD_ATTACHED)[1]}`);
      }
      message = `${message}${CARD_ATTACHED}${parts.join("\n\n")}`;
    }
    // Tickers named in the question ($NVDA or NVDA) that are listed.
    const listed = new Set((await import("@/lib/scout/symbol-search").then(({ listings }) => listings()).catch(() => [])).map((l) => l.s));
    const named = (await import("@/lib/scout/live-context")).tickersAsked(asked, listed);
    // A stock named without a card number: attach its latest card from the last 30 days (two stocks at most).
    if (!refs.length && named.length) {
      const latest = await store.latestCardIds(named.slice(0, 2)).catch(() => new Map<string, number>());
      const parts: string[] = [];
      for (const id of latest.values()) {
        const c = await store.getCard(id).catch(() => null);
        if (!c || Date.now() - Date.parse(c.createdAt) > 30 * 86400_000) continue;
        parts.push(`Latest card on ${c.primaryTicker} (#${c.id}), fetched now:\n${cardQuestion(c, await store.getTrack(c.id).catch(() => null), "").split(CARD_ATTACHED)[1]}`);
      }
      if (parts.length) message = `${message}${CARD_ATTACHED}${parts.join("\n\n")}`;
    }
    symbols = [...new Set([...symbols, ...named])];
  }
  // The price, moves and headlines as of now (the briefing is a snapshot from when the chat started), and a news search
  // on the question's key words, so the chat can answer about events the scout has not logged.
  const [live, search] = await Promise.all([
    symbols.length ? import("@/lib/scout/live-context").then(({ liveContext }) => liveContext(marketDataFromEnv(), symbols)).catch(() => null) : Promise.resolve(null),
    import("@/lib/scout/live-context").then(({ newsSearch }) => newsSearch(shownUserText(parsed.data.message))).catch(() => null),
  ]);
  for (const block of [live, search]) if (block) message = message.includes(CARD_ATTACHED) || message.includes(ATTACHED) ? `${message}\n\n${block}` : `${message}${ATTACHED}${block}`;
  // Your message is saved now; the reply is saved when it finishes, even if the page was closed meanwhile.
  await store.appendChat(t.id, [{ role: "user", content: message, at: new Date().toISOString() }]);
  const enc = new TextEncoder();
  let push: (s: string) => void = () => undefined;
  const turn = (async () => {
    let reply: string;
    try {
      reply = (await chatTurn({ ...t, messages: t.messages }, message, (piece) => push(piece))).text;
    } catch (err) {
      reply = `(Error: ${err instanceof Error ? err.message : String(err)})`;
      push(`\n\n${reply}`);
    }
    await store.appendChat(t.id, [{ role: "assistant", content: reply, at: new Date().toISOString() }]).catch(() => undefined);
  })();
  after(() => turn); // keep the function alive until the reply is saved
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      push = (piece) => { if (!open) return; try { controller.enqueue(enc.encode(piece)); } catch { open = false; } };
      void turn.finally(() => { if (open) { open = false; try { controller.close(); } catch { /* already closed */ } } });
    },
    cancel() { push = () => undefined; },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-thread-id": String(t.id), "x-briefing-chars": String(t.briefing.length) } });
}
