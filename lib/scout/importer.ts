/**
 * Import trade ideas from the daily stream file (its machine-readable block).
 * Each idea is researched like an "I noticed something" observation: logged
 * as human-originated, with the term prefixed "stream host:" or
 * "stream agent:" so the Scoring page can score the stream host's calls and
 * the file agent's own calls separately.
 */
import { z } from "zod";
import { KINDS, type Kind } from "@/config/scout";
import { researchCandidate, type ResearchDeps, type ResearchOutcome } from "./research";
import { normalizeTicker } from "./tickers";

export const importItemSchema = z.object({
  observation: z.string().trim().min(5).max(2000),
  term: z.string().trim().min(2).max(80),
  kind: z.enum(KINDS).catch("event"),
  tickers: z.array(z.string()).max(8).default([]),
  direction: z.enum(["long", "short"]).optional(),
  catalyst_date: z.string().optional(),
  source: z.enum(["host", "agent"]).catch("host"),
  confirmed: z.string().optional(),
  stream_time: z.string().optional(),
});
export type ImportItem = z.infer<typeof importItemSchema>;

/** Accepts the JSON block as pasted, including PDF line wraps and ```json fences. */
export function parseImport(text: string): { items: ImportItem[]; errors: string[] } {
  const body = text.replace(/```(?:json)?/g, "").replace(/[\r\n]+/g, " ").trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < start) return { items: [], errors: ["no JSON array found"] };
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    return { items: [], errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!Array.isArray(raw)) return { items: [], errors: ["expected a JSON array"] };
  const items: ImportItem[] = [];
  const errors: string[] = [];
  raw.forEach((x, i) => {
    const r = importItemSchema.safeParse(x);
    if (r.success) items.push(r.data);
    else errors.push(`item ${i + 1}: ${r.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`);
  });
  return { items, errors };
}

export const importTerm = (it: ImportItem) => `stream ${it.source}: ${it.term}`.slice(0, 80);

export function importObservation(it: ImportItem, label: string): string {
  const who = it.source === "host" ? "the stream host's idea" : "the file agent's own idea";
  const bits = [
    it.observation,
    `(From the ${label} daily stream file; ${who}`,
    it.direction ? `; proposed direction: ${it.direction}` : "",
    it.catalyst_date ? `; catalyst date: ${it.catalyst_date}` : "",
    it.confirmed ? `; facts confirmed: ${it.confirmed}` : "",
    it.stream_time ? `; stream time ${it.stream_time}` : "",
    ".)",
  ];
  return bits.join("").slice(0, 2000);
}

export interface ImportResult { term: string; outcome: string; cardId?: number; reason?: string }

/** Research the items, a few at a time. */
export async function runImport(items: ImportItem[], deps: ResearchDeps, label: string, concurrency = 3): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      const tickers = it.tickers.map(normalizeTicker).filter((t): t is string => !!t).slice(0, 5);
      let r: ResearchOutcome;
      try {
        r = await researchCandidate({ origin: "human", term: importTerm(it), kindHint: it.kind as Kind, tickersHint: tickers, observation: importObservation(it, label) }, deps);
      } catch (err) {
        out.push({ term: importTerm(it), outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      out.push(r.outcome === "card" ? { term: importTerm(it), outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term: importTerm(it), outcome: r.outcome, reason: r.reason });
      if (r.outcome === "capped") return;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
