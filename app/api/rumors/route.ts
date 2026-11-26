import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps } from "@/lib/scout/engine";
import { combineDocRumors, getRumor, imageAsText, partText, readRumorDoc, researchRumor } from "@/lib/scout/rumors";
import { joinParts } from "@/lib/files/unpack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CHARS = 400_000;

/**
 * Rumors tab: drop a document (pasted text, or an uploaded .txt / .md / .html / .pdf), read in the background;
 * { parts: [{ name, text }] } for several files unpacked in the browser (zips, Office files, images read by PUT);
 * or { action: "research", id } to check one rumor now.
 */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  let text = "", source = "", bundle = 0;
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
      z.object({ action: z.literal("combine"), docId: z.number().int().positive() }),
      z.object({ text: z.string().min(1), source: z.string().max(200).optional() }),
      z.object({ parts: z.array(z.object({ name: z.string().max(300), text: z.string() })).min(1).max(600), source: z.string().max(200).optional() }),
    ]).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: false, errors: ["send { text, source }, { parts, source } or { action: 'research', id }"] }, { status: 422 });
    if ("action" in parsed.data && parsed.data.action === "combine") {
      try {
        const res = await combineDocRumors(parsed.data.docId, defaultDeps());
        return NextResponse.json({ ok: true, ...res });
      } catch (err) {
        return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
      }
    }
    if ("parts" in parsed.data) {
      bundle = parsed.data.parts.filter((x) => x.text.trim()).length;
      const parts = await Promise.all(parsed.data.parts.map(async (x) => ({ name: x.name, text: await partText(x.text) })));
      parsed.data = { text: joinParts(parts, MAX_CHARS) || " ", source: parsed.data.source };
    }
    if ("action" in parsed.data && parsed.data.action === "research") {
      const r = await getRumor(parsed.data.id);
      if (!r) return NextResponse.json({ ok: false, errors: ["no such rumor"] }, { status: 404 });
      try {
        const { tracked } = await import("@/lib/scout/research-requests");
        const res = await tracked({ term: `Rumor #${r.id}: ${r.claim}`, tickers: r.tickers, from: { label: "Rumors", url: `/rumors#rumor-${r.id}` } }, () => researchRumor(defaultDeps(), r));
        return res.cardId ? NextResponse.json({ ok: true, cardId: res.cardId, status: res.status }) : NextResponse.json({ ok: false, errors: [`${res.outcome}${res.reason ? `: ${res.reason}` : ""}`] }, { status: 422 });
      } catch (err) {
        return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
      }
    }
    text = "text" in parsed.data ? parsed.data.text : "";
    source = parsed.data.source?.trim() ?? "";
  }
  text = text.trim();
  if (text.length < 40) return NextResponse.json({ ok: false, errors: ["nothing to read (paste the text or choose a file)"] }, { status: 422 });
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  const label = (source || `pasted ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).slice(0, 200);
  after(async () => {
    await readRumorDoc(text, label, defaultDeps(), null, { bundle }).catch((err) => console.error(`rumor read failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  return NextResponse.json({ ok: true, reading: label, chars: text.length }, { status: 202 });
}

/**
 * Read one image or PDF for the Rumors box and return its text (nothing is stored; the browser collects the pieces
 * and sends them with POST). An image comes as JSON { mediaType, data } already shrunk to a JPEG in the browser; a
 * PDF as a multipart "file" (under about 4 MB, Vercel's request limit). A PDF with a text layer is read for free;
 * a scanned one is read by the model, like an image.
 */
export async function PUT(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const { IMAGE_TYPES, readImage } = await import("@/lib/scout/image-read");
  const read = (media: { mediaType: string; data: string }, what: string) =>
    readImage(media, `This ${what} comes from a dump of posts and articles being read for market rumors. Transcribe the claims, names, companies and numbers it contains.`, { callModel: defaultDeps().callModel, now: new Date() });
  try {
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      // A long scan arrives a few pages at a time ("pages 5-8 of 40"): read those pages in full, not as one summary.
      const part = String(formData.get("part") ?? "").replace(/[^\w ,-]/g, "").slice(0, 40);
      if (!(file instanceof File) || !file.size) return NextResponse.json({ ok: false, errors: ["no file"] }, { status: 422 });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { fileText } = await import("@/lib/scout/inbox");
      const text = /\.pdf$/i.test(file.name) ? await fileText(file.name, bytes).catch(() => "") : "";
      if (text.replace(/\s+/g, "").length >= 50) return NextResponse.json({ ok: true, text, via: "text layer" });
      if (!/\.pdf$/i.test(file.name)) return NextResponse.json({ ok: false, errors: ["send a PDF here, or an image as JSON"] }, { status: 422 });
      const r = part
        ? await readImage({ mediaType: "application/pdf", data: Buffer.from(bytes).toString("base64") }, `These are ${part} of a scanned document a trader uploaded for research. Transcribe what matters on these pages in full: companies, tickers, drugs and trials, numbers, dates and claims, tables included. For this document text_in_image may run to about 4,000 characters.`, { callModel: defaultDeps().callModel, now: new Date() })
        : await read({ mediaType: "application/pdf", data: Buffer.from(bytes).toString("base64") }, "scanned PDF");
      return NextResponse.json({ ok: true, text: imageAsText(r), via: "read by the model (scanned)" });
    }
    const body = z.object({ mediaType: z.enum(IMAGE_TYPES), data: z.string().min(100).max(6_000_000) }).safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ ok: false, errors: ["send a JPEG, PNG, GIF or WebP image (under about 4 MB)"] }, { status: 422 });
    const r = await read(body.data, "image");
    return NextResponse.json({ ok: true, text: imageAsText(r), via: "read by the model" });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
