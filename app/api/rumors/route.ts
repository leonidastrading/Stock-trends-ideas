import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps } from "@/lib/scout/engine";
import { getRumor, readRumorDoc, researchRumor } from "@/lib/scout/rumors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CHARS = 400_000;

/**
 * Rumors tab: drop a document (pasted text, or an uploaded .txt / .md / .html / .pdf), read in the background;
 * or { action: "research", id } to check one rumor now.
 */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  let text = "", source = "";
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    source = String(form.get("source") ?? "").trim();
    if (file instanceof File && file.size) {
      if (file.size > 15_000_000) return NextResponse.json({ ok: false, errors: ["file over 15 MB"] }, { status: 413 });
      const { fileText } = await import("@/lib/scout/inbox");
      text = await fileText(file.name, new Uint8Array(await file.arrayBuffer()));
      source = source || file.name;
    } else text = String(form.get("text") ?? "");
  } else {
    const parsed = z.union([
      z.object({ action: z.literal("research"), id: z.number().int().positive() }),
      z.object({ text: z.string().min(1), source: z.string().max(200).optional() }),
    ]).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { text, source } or { action: 'research', id }"] }, { status: 422 });
    if ("action" in parsed.data) {
      const r = await getRumor(parsed.data.id);
      if (!r) return NextResponse.json({ ok: false, errors: ["no such rumor"] }, { status: 404 });
      try {
        const res = await researchRumor(defaultDeps(), r);
        return res.cardId ? NextResponse.json({ ok: true, cardId: res.cardId, status: res.status }) : NextResponse.json({ ok: false, errors: [`${res.outcome}${res.reason ? `: ${res.reason}` : ""}`] }, { status: 422 });
      } catch (err) {
        return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
      }
    }
    text = parsed.data.text;
    source = parsed.data.source?.trim() ?? "";
  }
  text = text.trim();
  if (text.length < 40) return NextResponse.json({ ok: false, errors: ["nothing to read (paste the text or choose a file)"] }, { status: 422 });
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  const label = (source || `pasted ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).slice(0, 200);
  after(async () => {
    await readRumorDoc(text, label, defaultDeps()).catch((err) => console.error(`rumor read failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  return NextResponse.json({ ok: true, reading: label, chars: text.length }, { status: 202 });
}
