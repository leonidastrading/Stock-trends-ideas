import { after, NextResponse } from "next/server";
import { z } from "zod";
import { KINDS } from "@/config/scout";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps, runImportJob } from "@/lib/scout/engine";
import { researchCandidate } from "@/lib/scout/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Longer than this, the text is treated as a pasted page or article: the ideas are pulled out of it first. */
const PASTE_CHARS = 1500;
/** An uploaded document: this many ideas are researched at once (inside this call's 5 minutes, three at a time)... */
const UPLOAD_IDEAS = 6;
/** ...and up to this many in all: the rest wait in line and are researched one after another, straight after. */
const UPLOAD_IDEAS_MAX = 24;

const schema = z.object({
  observation: z.string().trim().min(5).max(200_000),
  term: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(KINDS).nullable().optional(),
  tickers: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/)).max(5).optional(),
  /** Sent by a page's "Research it" button: researched as it is (never read as a pasted article), with its source. */
  direct: z.boolean().optional(),
  from: z.object({ label: z.string().trim().min(1).max(40), url: z.string().trim().max(400).nullable().optional() }).optional(),
  /** Sent by the Research tab: start the research and answer at once; the result shows on the tab when it is done. */
  background: z.boolean().optional(),
  /** Sent by the Research tab's upload: the observation is this document's text (the file name, for the record). */
  doc: z.string().trim().min(1).max(200).optional(),
});

/**
 * "I noticed something": research Vadim's observation now and return the card (human-originated).
 * A long paste (a whole page or article) is read for ideas first, like an inbox document; each idea is then
 * researched in the background and scored as Vadim's.
 */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  const { observation, term, kind, tickers, direct, from, background, doc } = parsed.data;
  try {
    // A long paste, or a document uploaded on its own (however short): the ideas are pulled out first.
    if ((observation.length > PASTE_CHARS || doc) && !direct) {
      const deps = defaultDeps();
      const { ideasFrom } = await import("@/lib/scout/inbox");
      const { items } = await ideasFrom(observation, doc ? `document Vadim uploaded: ${doc}` : "text pasted into I noticed something", deps, doc ? UPLOAD_IDEAS_MAX : 12);
      if (!items.length) return NextResponse.json({ ok: false, errors: [`No tradeable ideas found in the ${doc ? "document" : "pasted text"}. Add a sentence saying what you noticed, or name the tickers.`] }, { status: 422 });
      const { importResearchInput } = await import("@/lib/scout/importer");
      const { mergeSameStock } = await import("@/lib/scout/dedupe");
      const all = mergeSameStock(items.slice(0, doc ? UPLOAD_IDEAS_MAX : 12).map((it) => ({ ...it, source: "you" as const, kind: kind ?? it.kind, tickers: tickers?.length ? [...new Set([...tickers, ...it.tickers])].slice(0, 8) : it.tickers })));
      const label = `${doc ? `uploaded ${doc.slice(0, 60)}` : "pasted"} ${new Date().toISOString().slice(0, 10)}`;
      // An upload: the first six are researched inside this call's 5 minutes, three at a time; the rest wait in line.
      const mine = doc ? all.slice(0, UPLOAD_IDEAS) : all, later = doc ? all.slice(UPLOAD_IDEAS) : [];
      const from = { label: "Uploaded document", url: "/research" };
      if (later.length) {
        const { startRequest } = await import("@/lib/scout/research-requests");
        const { enqueue } = await import("@/lib/scout/catchup");
        for (const it of later) {
          const input = importResearchInput(it, label);
          const requestId = await startRequest({ term: input.term, tickers: input.tickersHint, from }, "queued").catch(() => undefined);
          await enqueue("research", `upload:${label}:${input.term.toLowerCase()}:${input.tickersHint.join(",")}`, { ...input, requestId });
        }
      }
      const origin = new URL(request.url).origin;
      after(async () => {
        await runImportJob(mine, label, deps, doc ? from : undefined).catch((err) => console.error(`pasted import failed: ${err instanceof Error ? err.message : String(err)}`));
        // The ideas in line start as soon as the first six are done (day or night), in calls of their own.
        if (later.length) await import("@/lib/scout/jobs").then(({ startJob }) => startJob(origin, "/api/cron/catchup", "lock:catchup:kick", 1)).catch(() => undefined);
      });
      return NextResponse.json({ ok: true, extracted: mine.map((m) => ({ term: m.term, tickers: m.tickers, direction: m.direction ?? null })), queued: later.map((m) => ({ term: m.term, tickers: m.tickers })), found: items.length, cut: observation.length > 60_000 }, { status: 202 });
    }
    const { tracked } = await import("@/lib/scout/research-requests");
    const label = term || observation.split(/[.!?\n]/)[0].slice(0, 80);
    const source = from ?? (background ? { label: "Research tab", url: "/research" } : { label: "Your note", url: "/notice" });
    const run = () => tracked({ term: label, tickers, from: source }, async () => {
      const r = await researchCandidate({ origin: "human", term: label, kindHint: kind ?? null, tickersHint: tickers ?? [], observation, source }, defaultDeps());
      return r.outcome === "card" ? { outcome: "card", cardId: r.card.id, status: r.card.status } : { outcome: r.outcome, reason: r.reason };
    });
    if (background) {
      after(async () => { await run().catch((err) => console.error(`research failed: ${err instanceof Error ? err.message : String(err)}`)); });
      return NextResponse.json({ ok: true, started: true }, { status: 202 });
    }
    const r = await run();
    if (r.cardId) return NextResponse.json({ ok: true, cardId: r.cardId, status: r.status });
    return NextResponse.json({ ok: false, outcome: r.outcome, errors: [r.reason] }, { status: 422 });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}

/** Read an uploaded image (base64, already shrunk in the browser) and return what to fill the form with. */
export async function PUT(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const { IMAGE_TYPES, observationFrom, readImage } = await import("@/lib/scout/image-read");
  const body = z.object({ mediaType: z.enum(IMAGE_TYPES), data: z.string().min(100).max(6_000_000), note: z.string().max(2000).default("") }).safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, errors: ["send a JPEG, PNG, GIF or WebP image (under about 4 MB)"] }, { status: 422 });
  try {
    const r = await readImage({ mediaType: body.data.mediaType, data: body.data.data }, body.data.note, { callModel: defaultDeps().callModel, now: new Date() });
    return NextResponse.json({ ok: true, reading: r, observation: observationFrom(r, body.data.note), term: r.term, tickers: r.tickers });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 500 });
  }
}
