/**
 * Nothing the scout reads is dropped because the daily AI budget ran out. Anything turned away by the cap goes on
 * this queue (an idea to research, the rest of a rumor document, a whole job such as the trend desk's discovery read,
 * Dots or Themes), and once the budget resets at midnight ET the queue is worked through, oldest first, until it is
 * empty or the new day's budget runs out (then it waits for the next reset). Investigations stopped by the cap are
 * re-run the same way. The queue is drained from the frequent cron calls (stories, news alerts) and the daily run.
 */
import { query as q } from "../db";
import type { MarketData } from "../alpaca";
import type { ResearchDeps, ResearchInput } from "./research";
import * as store from "./store";
import { toEt } from "../time";

/** A message saying the daily AI budget was reached (any of the wordings used across the scout). */
export const CAP_REASON = /daily (LLM|AI)( spending)? cap reached|credit balance is too low/i;

export type QueueKind = "research" | "rumor_doc" | "job";
export type QueueJob = "discovery" | "dots" | "themes" | "inbox_digest";

/** Put something on the queue unless the same thing is already waiting. */
export async function enqueue(kind: QueueKind, key: string, payload: unknown): Promise<void> {
  const k = key.slice(0, 300);
  const waiting = await q(`SELECT 1 FROM catchup_queue WHERE status = 'pending' AND kind = $1 AND key = $2 LIMIT 1`, [kind, k]);
  if (waiting.length) return;
  await q(`INSERT INTO catchup_queue (kind, key, payload) VALUES ($1, $2, $3)`, [kind, k, JSON.stringify(payload)]);
}

/** A research input as stored (without the source probes, which are taken again when it runs). */
export function queuedResearch(input: ResearchInput): Omit<ResearchInput, "results"> {
  const { results: _drop, ...rest } = input;
  void _drop;
  return rest;
}

export interface QueueRow { id: number; createdAt: string; kind: QueueKind; key: string; payload: unknown; status: string; attempts: number; doneAt: string | null; result: string | null }

export async function queueRows(status: "pending" | "done" | "all" = "pending", limit = 200): Promise<QueueRow[]> {
  const rows = await q(`SELECT * FROM catchup_queue ${status === "all" ? "" : "WHERE status = $2"} ORDER BY id ${status === "pending" ? "ASC" : "DESC"} LIMIT $1`, status === "all" ? [limit] : [limit, status]);
  return rows.map((r) => ({ id: Number(r.id), createdAt: new Date(r.created_at as string).toISOString(), kind: r.kind as QueueKind, key: String(r.key), payload: r.payload, status: String(r.status), attempts: Number(r.attempts ?? 0), doneAt: r.done_at ? new Date(r.done_at as string).toISOString() : null, result: (r.result as string) ?? null }));
}

const finish = (id: number, result: string) => q(`UPDATE catchup_queue SET status = 'done', done_at = now(), result = $2, attempts = attempts + 1 WHERE id = $1`, [id, result.slice(0, 500)]);
const tried = (id: number, result: string) => q(`UPDATE catchup_queue SET attempts = attempts + 1, result = $2 WHERE id = $1`, [id, result.slice(0, 500)]);

/** Run one queued job; returns its report line. */
async function runJob(job: QueueJob, deps: ResearchDeps & { data: MarketData | null }): Promise<string> {
  if (job === "discovery") return import("./scan").then(({ discoveryCatchUp }) => discoveryCatchUp(deps));
  if (job === "dots") return import("./dots").then(({ runDots }) => runDots(deps));
  if (job === "themes") return import("./themes").then(({ runThemes }) => runThemes(deps));
  return import("./inbox-digest").then(({ refreshInboxDigest }) => refreshInboxDigest(deps));
}

/**
 * Work through the queue, oldest first, while the day's budget lasts and before the deadline. Stops at the first item
 * the cap turns away again (it stays waiting for the next reset).
 */
export async function drainQueue(deps: ResearchDeps & { data: MarketData | null }, deadline = Date.now() + 200_000): Promise<string> {
  const settings = await store.loadSettings();
  if (!settings.enabled) return "scout is switched off";
  const today = toEt(deps.now).date;
  const capped = async () => (await store.spendOn(today)).cost >= settings.dailyCapUsd;
  // Investigations the cap stopped are run again first (you started them).
  const stopped = await q(`SELECT id FROM investigations WHERE status = 'error' AND error ~* 'daily (llm|ai)( spending)? cap reached' ORDER BY id`).catch(() => []);
  let done = 0;
  for (const r of stopped) {
    if (Date.now() > deadline || (await capped())) return `${done} caught up; budget used or out of time, the rest wait`;
    await q(`UPDATE investigations SET status = 'running', error = NULL WHERE id = $1`, [r.id]);
    const { runInvestigation } = await import("./investigate");
    await runInvestigation(Number(r.id), deps).catch(() => undefined);
    done++;
  }
  const pending = await queueRows("pending", 500);
  for (const item of pending) {
    if (Date.now() > deadline) break;
    if (await capped()) return `${done} caught up; ${pending.length - done} wait for the next budget reset`;
    try {
      if (item.kind === "research") {
        const { researchCandidate } = await import("./research");
        // `requestId`: an idea from a document uploaded on the Research tab; its line there gets the result.
        const { requestId, ...input } = item.payload as ResearchInput & { requestId?: number };
        const r = await researchCandidate({ ...input, queued: true }, deps);
        if (r.outcome === "capped") { await tried(item.id, r.reason); break; }
        if (requestId) await import("./research-requests").then(({ finishRequest }) => finishRequest(requestId, r.outcome === "card" ? { outcome: "card", cardId: r.card.id, status: r.card.status } : { outcome: r.outcome, reason: r.reason })).catch(() => undefined);
        await finish(item.id, r.outcome === "card" ? `card #${r.card.id}: ${r.card.status}` : `${r.outcome}: ${r.reason}`);
      } else if (item.kind === "rumor_doc") {
        const p = item.payload as { text: string; source: string };
        const { readRumorDoc } = await import("./rumors");
        const r = await readRumorDoc(p.text, p.source, deps, null, { queued: true });
        if (r.error && CAP_REASON.test(r.error) && r.rumors === 0) { await tried(item.id, r.error); break; }
        await finish(item.id, `${r.rumors} rumors${r.error ? ` (${r.error})` : ""}`);
      } else {
        // A queued job's own research respects this drain's deadline (what does not fit is queued again as single ideas).
        const res = await runJob((item.payload as { job: QueueJob }).job, { ...deps, startBy: deadline });
        if (CAP_REASON.test(res)) { await tried(item.id, res); break; }
        await finish(item.id, res);
      }
      done++;
    } catch (err) {
      await tried(item.id, err instanceof Error ? err.message : String(err));
    }
  }
  const left = Number((await q(`SELECT count(*) AS n FROM catchup_queue WHERE status = 'pending'`))[0].n);
  return `${done} caught up${left ? `; ${left} still waiting` : ""}`;
}

/** Work the queue in the background of a cron call (one runner at a time); a no-op when nothing is waiting. */
export async function catchUp(budgetMs: number): Promise<string> {
  const waiting = Number((await q(`SELECT count(*) AS n FROM catchup_queue WHERE status = 'pending'`))[0].n);
  const stopped = Number((await q(`SELECT count(*) AS n FROM investigations WHERE status = 'error' AND error ~* 'daily (llm|ai)( spending)? cap reached'`).catch(() => [{ n: 0 }]))[0].n);
  if (!waiting && !stopped) return "nothing waiting";
  if (!(await store.tryLock("lock:catchup", Math.ceil(budgetMs / 60_000) + 1))) return "another catch-up is running";
  try {
    const { defaultDeps } = await import("./engine");
    return await drainQueue(defaultDeps(), Date.now() + budgetMs);
  } finally {
    await store.unlock("lock:catchup").catch(() => undefined);
  }
}
