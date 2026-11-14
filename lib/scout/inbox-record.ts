/**
 * Track record of documents received: each GitHub inbox file, and each import
 * pasted on the page or posted to /api/cron/import, with what the scout did:
 * how the ideas were read, how many, and each idea's outcome (card and status,
 * or why it was rejected).
 */
export interface InboxFileRow { path: string; readAt: string; result: Record<string, unknown> | null }
export interface ImportRun { id: number; startedAt: string; finishedAt: string | null; status: string; detail: unknown; error: string | null }
export interface IdeaOutcome { term: string; outcome: string; cardId?: number; reason?: string }

export interface RecordRow {
  receivedAt: string;
  how: "github" | "pasted or posted";
  file: string | null;
  label: string;
  read: string;
  ideas: number | null;
  error: string | null;
  researchedAt: string | null;
  researchStatus: string | null;
  outcomes: IdeaOutcome[];
}

export const labelOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").slice(0, 40);

/** Pure: join inbox files with the import runs they started (by label, the run starting after the file was read). */
export function trackRecord(files: InboxFileRow[], runs: ImportRun[]): RecordRow[] {
  const used = new Set<number>();
  const rows: RecordRow[] = [];
  for (const f of files) {
    const label = labelOf(f.path);
    const r = f.result ?? {};
    if (typeof r.via === "string" && r.via.startsWith("twin of ")) continue; // the PDF whose text twin was read
    const run = runs
      .filter((x) => !used.has(x.id) && (x.detail as { label?: string } | null)?.label === label && Date.parse(x.startedAt) >= Date.parse(f.readAt) - 60_000)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (run) used.add(run.id);
    rows.push({
      receivedAt: f.readAt, how: "github", file: f.path, label,
      read: r.error ? "could not be read" : r.via === "block" ? "JSON ideas read directly" : r.via === "model" ? "ideas extracted by the model from the text" : String(r.via ?? "—"),
      ideas: typeof r.ideas === "number" ? r.ideas : null, error: typeof r.error === "string" ? r.error : null,
      researchedAt: run?.finishedAt ?? null, researchStatus: run ? run.status : r.ideas ? "queued" : null,
      outcomes: ((run?.detail as { results?: IdeaOutcome[] } | null)?.results ?? []),
    });
  }
  for (const run of runs.filter((x) => !used.has(x.id))) {
    const d = (run.detail ?? {}) as { label?: string; results?: IdeaOutcome[] };
    rows.push({ receivedAt: run.startedAt, how: "pasted or posted", file: null, label: d.label ?? "—", read: "JSON ideas read directly", ideas: d.results?.length ?? null, error: run.error, researchedAt: run.finishedAt, researchStatus: run.status, outcomes: d.results ?? [] });
  }
  return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}
