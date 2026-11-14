import { after, NextResponse } from "next/server";
import { hasDatabase } from "../db";
import { runImportJob } from "./engine";
import { parseImport } from "./importer";

/** Shared by /api/import (dashboard login) and /api/cron/import (cron secret). Replies at once; research runs after the response. */
export async function handleImport(request: Request): Promise<Response> {
  if (!hasDatabase()) return NextResponse.json({ ok: false, errors: ["database not connected"] }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { text?: string; label?: string } | null;
  if (!body?.text) return NextResponse.json({ ok: false, errors: ["send { text: <the JSON block>, label: <file date> }"] }, { status: 422 });
  const { items, errors } = parseImport(body.text);
  if (!items.length) return NextResponse.json({ ok: false, errors: errors.length ? errors : ["no ideas found"] }, { status: 422 });
  const label = (body.label ?? "").trim().slice(0, 40) || new Date().toISOString().slice(0, 10);
  after(async () => {
    try {
      await runImportJob(items.slice(0, 12), label);
    } catch (err) {
      console.error(`import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return NextResponse.json({ ok: true, accepted: Math.min(items.length, 12), skipped: errors, note: "researching in the background; cards appear on Candidates in a few minutes" }, { status: 202 });
}
