import { after, NextResponse } from "next/server";
import { z } from "zod";
import { checkBasicAuth } from "@/lib/auth";
import { hasDatabase } from "@/lib/db";
import { defaultDeps, runImportJob } from "@/lib/scout/engine";
import type { ImportItem } from "@/lib/scout/importer";
import { addSite, checkSite, LATEST, readLatest } from "@/lib/scout/sites";
import * as store from "@/lib/scout/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), url: z.string().trim().min(3).max(500), label: z.string().trim().max(60).optional(), kind: z.enum(["ideas", "rumors"]).optional(), readLatest: z.boolean().optional() }),
  z.object({ action: z.literal("latest"), id: z.number().int() }),
  z.object({ action: z.literal("kind"), id: z.number().int(), kind: z.enum(["ideas", "rumors"]) }),
  z.object({ action: z.literal("pause"), id: z.number().int(), active: z.boolean() }),
  z.object({ action: z.literal("remove"), id: z.number().int() }),
  z.object({ action: z.literal("check"), id: z.number().int() }),
]);

/** Settings → Your websites: add, pause, remove, or read one now. */
export async function POST(request: Request) {
  if (!checkBasicAuth(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
  const b = parsed.data;
  // Ideas are researched after the reply, in this function's remaining time.
  const deliver = async (items: ImportItem[], label: string) => {
    after(() => runImportJob(items, label).then(() => undefined).catch((err) => console.error(`site import failed: ${err instanceof Error ? err.message : String(err)}`)));
    return `${items.length} idea(s) sent to research`;
  };
  // The latest articles take minutes (PDFs, two AI calls, research): read after the reply.
  const latestLater = (site: store.Site) => after(() => readLatest(site, defaultDeps(), deliver).then((r) => console.log(`site latest: ${r}`)).catch((err) => console.error(`site latest failed: ${err instanceof Error ? err.message : String(err)}`)));
  try {
    if (b.action === "add") {
      const { site, found } = await addSite(b.url, b.label, undefined, b.kind ?? "ideas");
      if (b.readLatest !== false) latestLater(site);
      return NextResponse.json({ ok: true, message: `Added ${site.label}: ${site.detail}${b.readLatest !== false ? `. Reading the latest ${LATEST.articles} now: digests, ${site.kind === "rumors" ? "rumors" : "trade ideas to research"} in a few minutes (refresh to see).` : ""}`, found });
    }
    if (b.action === "latest") {
      const site = await store.getSite(b.id);
      if (!site) return NextResponse.json({ ok: false, errors: ["no such site"] }, { status: 404 });
      latestLater(site);
      return NextResponse.json({ ok: true, message: `${site.label}: reading the latest ${LATEST.articles} articles or reports now (a few minutes; this row updates when done, refresh to see).` });
    }
    if (b.action === "kind") {
      await store.setSiteKind(b.id, b.kind);
      return NextResponse.json({ ok: true });
    }
    if (b.action === "pause") {
      await store.setSiteActive(b.id, b.active);
      return NextResponse.json({ ok: true });
    }
    if (b.action === "remove") {
      await store.deleteSite(b.id);
      return NextResponse.json({ ok: true });
    }
    const site = await store.getSite(b.id);
    if (!site) return NextResponse.json({ ok: false, errors: ["no such site"] }, { status: 404 });
    const r = await checkSite(site, defaultDeps(), deliver);
    return NextResponse.json({ ok: true, message: r.error ? `${site.label}: ${r.error}` : `${site.label}: ${r.newArticles ?? 0} new article(s)${r.read ? `, ${r.read} read, ${r.ideas} idea(s) sent to research (cards in a few minutes)` : ""}` });
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : String(err)] }, { status: 422 });
  }
}
