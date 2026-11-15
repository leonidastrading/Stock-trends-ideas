import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps } from "@/lib/scout/engine";
import { getInvestigation, researchExposure, runInvestigation, startInvestigation } from "@/lib/scout/investigate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.union([
  z.object({ action: z.literal("research"), id: z.number().int().positive(), ticker: z.string().regex(/^[A-Z]{1,5}(\.[A-Z])?$/) }),
  z.object({ text: z.string().max(300_000).default(""), url: z.string().max(1000).optional() }),
]);

/** Start an investigation (story text and/or an article link; runs in the background), or research one listed exposure. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { text, url } or { action: 'research', id, ticker }"] }, { status: 422 });
  const b = parsed.data;
  if ("action" in b) {
    const inv = await getInvestigation(b.id);
    if (!inv?.report) return NextResponse.json({ ok: false, errors: ["that investigation has no report"] }, { status: 404 });
    try {
      const r = await researchExposure(defaultDeps(), inv, b.ticker);
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
  if (text.length < 40) return NextResponse.json({ ok: false, errors: ["paste the story, transcript or question (or a link to an article)"] }, { status: 422 });
  const id = await startInvestigation(text);
  after(() => runInvestigation(id, defaultDeps()).catch((err) => console.error(`investigation ${id} failed: ${err instanceof Error ? err.message : String(err)}`)));
  return NextResponse.json({ ok: true, id }, { status: 202 });
}
