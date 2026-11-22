/**
 * Research you asked for: every "Research it" button (News, Filings, Pharma, Court, Dots, Themes, Rumors,
 * Investigate) and the Research tab's own form. Each request is logged when it starts and updated when it ends,
 * so the Research tab lists them all with their result, and the menu's red badge counts the ones finished since
 * you last looked. The cards themselves are written and scored exactly as before.
 */
import { query as q } from "../db";

export interface ResearchRequest {
  id: number; createdAt: string; finishedAt: string | null; term: string; tickers: string[]; fromLabel: string | null; fromUrl: string | null;
  status: "running" | "card" | "rejected" | "error"; cardId: number | null; cardStatus: string | null; reason: string | null;
}

export type ResearchResult = { cardId?: number; status?: string; outcome: string; reason?: string };

/** Running longer than this, a request is shown as not finished (the server's time limit is 5 minutes). */
export const STALE_MIN = 8;

const toReq = (r: Record<string, unknown>): ResearchRequest => ({
  id: Number(r.id), createdAt: new Date(r.created_at as string).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
  term: String(r.term ?? ""), tickers: (r.tickers as string[]) ?? [], fromLabel: (r.from_label as string) ?? null, fromUrl: (r.from_url as string) ?? null,
  status: r.status as ResearchRequest["status"], cardId: r.card_id === null || r.card_id === undefined ? null : Number(r.card_id), cardStatus: (r.card_status as string) ?? null, reason: (r.reason as string) ?? null,
});

export async function startRequest(m: { term: string; tickers?: string[]; from?: { label: string; url?: string | null } | null }): Promise<number> {
  const r = await q(`INSERT INTO research_requests (term, tickers, from_label, from_url) VALUES ($1, $2, $3, $4) RETURNING id`, [m.term.slice(0, 200), (m.tickers ?? []).slice(0, 8), m.from?.label?.slice(0, 60) ?? null, m.from?.url?.slice(0, 400) ?? null]);
  return Number(r[0].id);
}

/** Pure: what a research result means for the request. */
export function requestOutcome(r: ResearchResult | { error: string }): { status: ResearchRequest["status"]; cardId: number | null; cardStatus: string | null; reason: string | null } {
  if ("error" in r) return { status: "error", cardId: null, cardStatus: null, reason: r.error.slice(0, 500) };
  if (r.cardId) return { status: "card", cardId: r.cardId, cardStatus: r.status ?? null, reason: null };
  return { status: r.outcome === "rejected" ? "rejected" : "error", cardId: null, cardStatus: null, reason: `${r.outcome}${r.reason ? `: ${r.reason}` : ""}`.slice(0, 500) };
}

export async function finishRequest(id: number, r: ResearchResult | { error: string }): Promise<void> {
  const o = requestOutcome(r);
  await q(`UPDATE research_requests SET status = $2, card_id = $3, card_status = $4, reason = $5, finished_at = now() WHERE id = $1`, [id, o.status, o.cardId, o.cardStatus, o.reason]);
}

/** Run one research request, logged before and after. Logging never stops the research. */
export async function tracked<T extends ResearchResult>(m: { term: string; tickers?: string[]; from?: { label: string; url?: string | null } | null }, run: () => Promise<T>): Promise<T> {
  const id = await startRequest(m).catch(() => null);
  try {
    const out = await run();
    if (id) await finishRequest(id, out).catch(() => undefined);
    return out;
  } catch (err) {
    if (id) await finishRequest(id, { error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
    throw err;
  }
}

/** Pure: a request still "running" long after the server's time limit did not finish. */
export const isStale = (r: ResearchRequest, now = new Date()) => r.status === "running" && now.getTime() - Date.parse(r.createdAt) > STALE_MIN * 60_000;

export async function listRequests(limit = 200): Promise<ResearchRequest[]> {
  return (await q(`SELECT * FROM research_requests ORDER BY id DESC LIMIT $1`, [limit])).map(toReq);
}
