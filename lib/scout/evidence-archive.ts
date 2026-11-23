/**
 * Saving the evidence: every web address a card or an investigation report cites is queued, and a background job
 * saves each to the Wayback Machine (a few at a time: anonymous saving is slow and rate-limited), so the source stays
 * verifiable if the page later changes or disappears. Cards show the saved copies next to their sources.
 */
import { query as q } from "../db";

export const EVIDENCE = { perRun: 4, maxAttempts: 3, perDay: 60 };

/** Pure: the distinct web addresses in any text or JSON (trailing punctuation removed; archive links left out). */
export function urlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]}]+/g)) {
    const u = m[0].replace(/[.,;:!?]+$/, "");
    if (/web\.archive\.org|archive\.org\/wayback|localhost|\/api\/chart\//.test(u)) continue;
    out.add(u);
  }
  return [...out].slice(0, 40);
}

/** Queue addresses for saving, noting who cited them (e.g. "card:217", "investigation:20"). */
export async function queueEvidence(urls: string[], by: string): Promise<number> {
  let n = 0;
  for (const u of urls) {
    const r = await q(`INSERT INTO evidence_archive (url, cited_by) VALUES ($1, ARRAY[$2]) ON CONFLICT (url) DO UPDATE SET cited_by = CASE WHEN $2 = ANY(evidence_archive.cited_by) THEN evidence_archive.cited_by ELSE array_append(evidence_archive.cited_by, $2) END RETURNING (xmax = 0) AS fresh`, [u.slice(0, 1000), by]);
    if (r[0]?.fresh) n++;
  }
  return n;
}

/** One pass: save a few queued addresses. */
export async function runEvidenceArchive(fetchImpl: typeof fetch = fetch): Promise<string> {
  const today = (await q(`SELECT count(*) AS n FROM evidence_archive WHERE saved_at > now() - interval '1 day'`))[0];
  if (Number(today?.n ?? 0) >= EVIDENCE.perDay) return "evidence: daily saving limit reached";
  const due = await q(`SELECT url FROM evidence_archive WHERE archive_url IS NULL AND attempts < $1 ORDER BY first_cited ASC LIMIT $2`, [EVIDENCE.maxAttempts, EVIDENCE.perRun]);
  const { savePage } = await import("../sources/wayback");
  let saved = 0;
  for (const r of due) {
    const url = String(r.url);
    const a = await savePage(url, fetchImpl).catch(() => null);
    await q(`UPDATE evidence_archive SET attempts = attempts + 1, archive_url = coalesce($2, archive_url), saved_at = CASE WHEN $2 IS NULL THEN saved_at ELSE now() END WHERE url = $1`, [url, a]);
    if (a) saved++;
  }
  return `evidence: ${saved} of ${due.length} saved to the Wayback Machine`;
}

/** Saved copies for the addresses a card or investigation cited. */
export async function savedCopies(by: string): Promise<Array<{ url: string; archiveUrl: string | null }>> {
  return (await q(`SELECT url, archive_url FROM evidence_archive WHERE $1 = ANY(cited_by) ORDER BY first_cited`, [by]).catch(() => [])).map((r) => ({ url: String(r.url), archiveUrl: (r.archive_url as string) ?? null }));
}
