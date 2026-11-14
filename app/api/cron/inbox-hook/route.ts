import { after, NextResponse } from "next/server";
import { validSignature } from "@/lib/scout/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GitHub webhook on the inbox repo (push events): read the new files right away instead of at the next hourly
 * check. The webhook's secret is GITHUB_INBOX_WEBHOOK_SECRET, or CRON_SECRET when that is not set.
 */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_INBOX_WEBHOOK_SECRET?.trim() || process.env.CRON_SECRET?.trim() || "";
  const body = await request.text();
  if (!validSignature(body, request.headers.get("x-hub-signature-256"), secret)) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  if (request.headers.get("x-github-event") === "ping") return NextResponse.json({ ok: true, pong: true });
  after(async () => {
    const [{ inboxConfig, pollInbox }, { defaultDeps }] = await Promise.all([import("@/lib/scout/inbox"), import("@/lib/scout/engine")]);
    if (inboxConfig()) await pollInbox(defaultDeps(), 50, fetch, undefined, Date.now() + 240_000).catch(() => undefined);
  });
  return NextResponse.json({ ok: true, reading: true }, { status: 202 });
}
