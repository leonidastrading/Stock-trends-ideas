import { NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { continueDaily, runDaily, runStoriesJob, runTrack } from "@/lib/scout/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "Run now" from the Settings page: the same jobs the cron calls, behind the dashboard login. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { job?: string };
  try {
    if (body.job === "track") return NextResponse.json({ ok: true, result: await runTrack() });
    if (body.job === "daily") {
      const r = await runDaily();
      const next = await continueDaily(new URL(request.url).origin, r).catch(() => false);
      return NextResponse.json({ ok: true, result: { ...r, nextPassStarted: next } });
    }
    if (body.job === "stories") return NextResponse.json({ ok: true, result: await runStoriesJob() });
    if (body.job === "push-test") {
      const { pushConfigured, sendPush } = await import("@/lib/notify");
      if (!pushConfigured()) return NextResponse.json({ ok: false, errors: ["NTFY_TOPIC is not set"] }, { status: 422 });
      await sendPush({ title: "Trend scout: test", message: "Phone alerts are working. New promoted cards, story trades and post-catalyst verdicts will arrive here.", tags: ["bell"], click: process.env.DASHBOARD_URL });
      return NextResponse.json({ ok: true, result: { sent: true } });
    }
    if (body.job === "inbox") {
      const { inboxConfig, pollInbox } = await import("@/lib/scout/inbox");
      if (!inboxConfig()) return NextResponse.json({ ok: false, errors: ["GITHUB_INBOX_REPO is not set"] }, { status: 422 });
      const { defaultDeps } = await import("@/lib/scout/engine");
      return NextResponse.json({ ok: true, result: await pollInbox(defaultDeps(), 50, fetch, undefined, Date.now() + 240_000) });
    }
    if (body.job === "inbox-digest") {
      const [{ refreshInboxDigest }, { defaultDeps }] = await Promise.all([import("@/lib/scout/inbox-digest"), import("@/lib/scout/engine")]);
      return NextResponse.json({ ok: true, result: { message: await refreshInboxDigest(defaultDeps()) } });
    }
    if (body.job === "swing-test") {
      const { testSwingLogin } = await import("@/lib/scout/swing");
      const r = await testSwingLogin();
      return NextResponse.json(r.ok ? { ok: true, result: { message: r.message } } : { ok: false, errors: [r.message] }, { status: r.ok ? 200 : 422 });
    }
    return NextResponse.json({ ok: false, errors: ["job must be 'daily', 'stories', 'track', 'push-test', 'swing-test', 'inbox' or 'inbox-digest'"] }, { status: 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
