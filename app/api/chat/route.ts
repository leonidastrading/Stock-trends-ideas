import { NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { buildBriefing, chatTurn } from "@/lib/scout/chat";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({ thread: z.number().int().positive().optional(), message: z.string().trim().min(1).max(20_000) });

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
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const at = new Date().toISOString();
      try {
        const r = await chatTurn(t, message, (piece) => controller.enqueue(enc.encode(piece)));
        await store.appendChat(t.id, [{ role: "user", content: message, at }, { role: "assistant", content: r.text, at: new Date().toISOString() }]);
      } catch (err) {
        controller.enqueue(enc.encode(`\n\n(Error: ${err instanceof Error ? err.message : String(err)})`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-thread-id": String(t.id), "x-briefing-chars": String(t.briefing.length) } });
}
