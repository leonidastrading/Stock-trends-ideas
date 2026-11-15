import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { buildBriefing, CHAT_MAX_CHARS, chatTurn } from "@/lib/scout/chat";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({ thread: z.number().int().positive().optional(), message: z.string().trim().min(1).max(CHAT_MAX_CHARS, `That message is too long (over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters). Split it into parts.`) });

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
  if (!thread) {
    const id = await store.createChatThread(await buildBriefing());
    thread = (await store.getChatThread(id))!;
  }
  const t = thread;
  const message = parsed.data.message;
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
