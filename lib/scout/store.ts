/** Postgres queries for the scout. Thin and typed; no business rules here. */
import { SCOUT, SEED_WATCHLIST, type Kind } from "@/config/scout";
import { query as q, type Row } from "../db";
import type { Signal } from "../sources";
import type { Card, CardStatus } from "./card";
import type { Effort } from "./llm";

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const dstr = (v: unknown) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

// ---------------------------------------------------------------- settings

export interface ScoutSettings {
  enabled: boolean;
  model: string;
  effort: Effort;
  dailyCapUsd: number;
  maxCandidatesPerScan: number;
  discoveryPerScan: number;
  emailDigest: boolean;
}

export const DEFAULT_SETTINGS: ScoutSettings = {
  enabled: true, model: SCOUT.defaultModel, effort: SCOUT.defaultEffort, dailyCapUsd: SCOUT.defaultDailyCapUsd, maxCandidatesPerScan: SCOUT.maxCandidatesPerScan, discoveryPerScan: SCOUT.discoveryPerScan, emailDigest: true,
};

export async function loadSettings(): Promise<ScoutSettings> {
  const rows = await q(`SELECT value FROM settings WHERE key = 'scout'`);
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(s: ScoutSettings): Promise<void> {
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ('scout', $1, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(s)]);
}

// ---------------------------------------------------------------- versions

export interface Version { id: number; hash: string; model: string; effort: string; createdAt: string }

export async function ensureVersion(hash: string, model: string, effort: string, spec: unknown): Promise<Version> {
  await q(`INSERT INTO scout_versions (hash, model, effort, spec) VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO NOTHING`, [hash, model, effort, JSON.stringify(spec)]);
  const r = (await q(`SELECT id, hash, model, effort, created_at FROM scout_versions WHERE hash = $1`, [hash]))[0];
  return { id: Number(r.id), hash: r.hash, model: r.model, effort: r.effort, createdAt: iso(r.created_at)! };
}

export async function listVersions(): Promise<Version[]> {
  return (await q(`SELECT id, hash, model, effort, created_at FROM scout_versions ORDER BY id`)).map((r) => ({ id: Number(r.id), hash: r.hash, model: r.model, effort: r.effort, createdAt: iso(r.created_at)! }));
}

// --------------------------------------------------------------- watchlist

export interface WatchItem { id: number; term: string; kind: Kind; tickers: string[]; addedBy: string; status: "active" | "proposed" | "retired"; note: string | null; addedAt: string }

const toWatch = (r: Row): WatchItem => ({ id: Number(r.id), term: r.term, kind: r.kind, tickers: r.tickers ?? [], addedBy: r.added_by, status: r.status, note: r.note, addedAt: iso(r.added_at)! });

export async function seedWatchlist(): Promise<void> {
  const n = Number((await q(`SELECT count(*) AS n FROM watchlist`))[0].n);
  if (n > 0) return;
  for (const w of SEED_WATCHLIST) await q(`INSERT INTO watchlist (term, kind, tickers, added_by, status) VALUES ($1, $2, $3, 'seed', 'active') ON CONFLICT DO NOTHING`, [w.term, w.kind, w.tickers]);
}

export async function watchlist(status?: WatchItem["status"]): Promise<WatchItem[]> {
  const rows = status ? await q(`SELECT * FROM watchlist WHERE status = $1 ORDER BY added_at`, [status]) : await q(`SELECT * FROM watchlist ORDER BY status, added_at`);
  return rows.map(toWatch);
}

export async function addWatch(w: { term: string; kind: Kind; tickers: string[]; addedBy: string; status: WatchItem["status"]; note?: string }): Promise<WatchItem | null> {
  const rows = await q(
    `INSERT INTO watchlist (term, kind, tickers, added_by, status, note) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING *`,
    [w.term.trim(), w.kind, w.tickers.map((t) => t.toUpperCase()), w.addedBy, w.status, w.note ?? null],
  );
  return rows[0] ? toWatch(rows[0]) : null;
}

export async function setWatchStatus(id: number, status: WatchItem["status"]): Promise<void> {
  await q(`UPDATE watchlist SET status = $2 WHERE id = $1`, [id, status]);
}

// ----------------------------------------------------------------- signals

export async function saveSignals(term: string, signals: Signal[], measuredOn: string | null = null): Promise<void> {
  for (const s of signals) {
    await q(
      `INSERT INTO signals (source, term, metric, as_of, value, baseline, change_vs_12m, detail, note, measured_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source, term, metric, as_of) DO UPDATE SET value = excluded.value, baseline = excluded.baseline, change_vs_12m = excluded.change_vs_12m, detail = excluded.detail, note = excluded.note, measured_on = coalesce(excluded.measured_on, signals.measured_on)`,
      [s.source, term, s.metric, s.asOf, s.value, s.baseline, s.changeVs12m, s.detail ? JSON.stringify(s.detail) : null, s.note, measuredOn],
    );
  }
}

/** Stored history for a term: average value and row count per (source, metric) over the last 365 days, excluding today. */
export async function signalHistory(term: string, today: string): Promise<Record<string, { avg: number; n: number; first: string }>> {
  const rows = await q(
    `SELECT source, metric, avg(value) AS avg, count(*) AS n, min(as_of) AS first FROM signals
     WHERE term = $1 AND as_of < $2 AND as_of >= ($2::date - 365) AND value IS NOT NULL GROUP BY source, metric`,
    [term, today],
  );
  return Object.fromEntries(rows.map((r) => [`${r.source}:${r.metric}`, { avg: Number(r.avg), n: Number(r.n), first: dstr(r.first)! }]));
}

const toSignal = (r: Row): Signal => ({ source: r.source, metric: r.metric, value: Number(r.value), baseline: num(r.baseline), changeVs12m: num(r.change_vs_12m), asOf: dstr(r.as_of)!, note: r.note ?? "", detail: r.detail ?? undefined });

export async function recentSignals(term: string, days = 30): Promise<Array<Signal & { term: string }>> {
  const rows = await q(`SELECT * FROM signals WHERE term = $1 AND as_of >= current_date - $2::int ORDER BY as_of DESC`, [term, days]);
  return rows.map((r) => ({ term: r.term, ...toSignal(r) }));
}

/** Signals a scan already measured for a term on a given ET date, keyed by source: a second scan that day reuses them instead of calling the source again. */
export async function signalsOn(term: string, date: string): Promise<Map<string, Signal[]>> {
  const rows = await q(`SELECT * FROM signals WHERE term = $1 AND measured_on = $2 ORDER BY source, metric`, [term, date]);
  const m = new Map<string, Signal[]>();
  for (const r of rows) m.set(r.source, [...(m.get(r.source) ?? []), toSignal(r)]);
  return m;
}

// ----------------------------------------------------------- source health

export interface Health { source: string; status: string; detail: string | null; checkedAt: string }

export async function saveHealth(source: string, status: string, detail: string | null): Promise<void> {
  await q(`INSERT INTO source_health (source, status, detail, checked_at) VALUES ($1, $2, $3, now()) ON CONFLICT (source) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = now()`, [source, status, detail]);
}

export async function allHealth(): Promise<Health[]> {
  return (await q(`SELECT * FROM source_health ORDER BY source`)).map((r) => ({ source: r.source, status: r.status, detail: r.detail, checkedAt: iso(r.checked_at)! }));
}

// -------------------------------------------------------------- candidates

export interface Candidate { id: number; versionId: number; createdAt: string; origin: "scout" | "human"; term: string; kindHint: string | null; tickersHint: string[]; observation: string | null; trigger: Signal[] | null; outcome: "card" | "rejected" | "error"; reason: string | null; cardId: number | null }

const toCandidate = (r: Row): Candidate => ({ id: Number(r.id), versionId: Number(r.version_id), createdAt: iso(r.created_at)!, origin: r.origin, term: r.term, kindHint: r.kind_hint, tickersHint: r.tickers_hint ?? [], observation: r.observation, trigger: r.trigger, outcome: r.outcome, reason: r.reason, cardId: num(r.card_id) });

export async function addCandidate(c: Omit<Candidate, "id" | "createdAt">): Promise<Candidate> {
  const rows = await q(
    `INSERT INTO candidates (version_id, origin, term, kind_hint, tickers_hint, observation, trigger, outcome, reason, card_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [c.versionId, c.origin, c.term, c.kindHint, c.tickersHint, c.observation, c.trigger ? JSON.stringify(c.trigger) : null, c.outcome, c.reason, c.cardId],
  );
  return toCandidate(rows[0]);
}

export async function candidatesSince(days: number): Promise<Candidate[]> {
  return (await q(`SELECT * FROM candidates WHERE created_at >= now() - ($1::int * interval '1 day') ORDER BY created_at DESC`, [days])).map(toCandidate);
}

/** Terms researched (any outcome) in the last `days` days, for the cooldown. */
export async function recentTerms(days: number): Promise<Set<string>> {
  const rows = await q(`SELECT DISTINCT lower(term) AS t FROM candidates WHERE created_at >= now() - ($1::int * interval '1 day')`, [days]);
  return new Set(rows.map((r) => r.t));
}

// ------------------------------------------------------------------- cards

export interface StoredCard {
  id: number; versionId: number; createdAt: string; origin: "scout" | "human"; kind: Kind; title: string; card: Card; model: string; modelServed: string | null;
  costUsd: number | null; status: CardStatus; gateNotes: string[]; primaryTicker: string; sector: string; direction: "long" | "short"; timeLimitDays: number; catalystDate: string | null; rankScore: number;
}

const toCard = (r: Row): StoredCard => ({
  id: Number(r.id), versionId: Number(r.version_id), createdAt: iso(r.created_at)!, origin: r.origin, kind: r.kind, title: r.title, card: r.card, model: r.model, modelServed: r.model_served,
  costUsd: num(r.cost_usd), status: r.status, gateNotes: r.gate_notes ?? [], primaryTicker: r.primary_ticker, sector: r.sector, direction: r.direction, timeLimitDays: Number(r.time_limit_days),
  catalystDate: dstr(r.catalyst_date), rankScore: Number(r.rank_score),
});

const CARD_COLS = `id, version_id, created_at, origin, kind, title, card, model, model_served, cost_usd, status, gate_notes, primary_ticker, sector, direction, time_limit_days, catalyst_date, rank_score`;

export async function insertCard(c: {
  versionId: number; origin: "scout" | "human"; card: Card; model: string; modelServed: string | null; prompt: string; replyText: string; usage: unknown; costUsd: number | null;
  status: CardStatus; gateNotes: string[]; catalystDate: string | null; rankScore: number;
}): Promise<StoredCard> {
  const primary = c.card.tickers[0];
  const rows = await q(
    `INSERT INTO cards (version_id, origin, kind, title, card, model, model_served, prompt, reply_text, usage, cost_usd, status, gate_notes, primary_ticker, sector, direction, time_limit_days, catalyst_date, rank_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING ${CARD_COLS}`,
    [c.versionId, c.origin, c.card.kind, c.card.title, JSON.stringify(c.card), c.model, c.modelServed, c.prompt, c.replyText, JSON.stringify(c.usage ?? null), c.costUsd, c.status, c.gateNotes, primary.symbol, primary.sector, c.card.direction, c.card.time_limit_days, c.catalystDate, c.rankScore],
  );
  return toCard(rows[0]);
}

export async function getCard(id: number): Promise<StoredCard | null> {
  const rows = await q(`SELECT ${CARD_COLS} FROM cards WHERE id = $1`, [id]);
  return rows[0] ? toCard(rows[0]) : null;
}

export async function cardsSince(days: number): Promise<StoredCard[]> {
  return (await q(`SELECT ${CARD_COLS} FROM cards WHERE created_at >= now() - ($1::int * interval '1 day') ORDER BY created_at DESC`, [days])).map(toCard);
}

export async function allCards(): Promise<StoredCard[]> {
  return (await q(`SELECT ${CARD_COLS} FROM cards ORDER BY created_at`)).map(toCard);
}

export async function cardPrompt(id: number): Promise<{ prompt: string; replyText: string } | null> {
  const r = (await q(`SELECT prompt, reply_text FROM cards WHERE id = $1`, [id]))[0];
  return r ? { prompt: r.prompt, replyText: r.reply_text } : null;
}

// ------------------------------------------------------------------ tracks

export interface Track {
  cardId: number; symbol: string; sectorEtf: string; direction: "long" | "short"; cardDate: string; entryDate: string | null; entryPrice: number | null; spyEntry: number | null; sectorEntry: number | null;
  deadlineDate: string; exitDate: string | null; exitPrice: number | null; spyExit: number | null; sectorExit: number | null; exitReason: string | null; maxDrawdownPct: number | null; tappedAt: string | null; swingResponse: unknown;
}

const toTrack = (r: Row): Track => ({
  cardId: Number(r.card_id), symbol: r.symbol, sectorEtf: r.sector_etf, direction: r.direction, cardDate: dstr(r.card_date)!, entryDate: dstr(r.entry_date), entryPrice: num(r.entry_price), spyEntry: num(r.spy_entry), sectorEntry: num(r.sector_entry),
  deadlineDate: dstr(r.deadline_date)!, exitDate: dstr(r.exit_date), exitPrice: num(r.exit_price), spyExit: num(r.spy_exit), sectorExit: num(r.sector_exit), exitReason: r.exit_reason, maxDrawdownPct: num(r.max_drawdown_pct), tappedAt: iso(r.tapped_at), swingResponse: r.swing_response,
});

export async function insertTrack(t: { cardId: number; symbol: string; sectorEtf: string; direction: "long" | "short"; cardDate: string; deadlineDate: string }): Promise<void> {
  await q(`INSERT INTO tracks (card_id, symbol, sector_etf, direction, card_date, deadline_date) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (card_id) DO NOTHING`, [t.cardId, t.symbol, t.sectorEtf, t.direction, t.cardDate, t.deadlineDate]);
}

export async function allTracks(): Promise<Track[]> {
  return (await q(`SELECT * FROM tracks ORDER BY card_id`)).map(toTrack);
}

export async function getTrack(cardId: number): Promise<Track | null> {
  const rows = await q(`SELECT * FROM tracks WHERE card_id = $1`, [cardId]);
  return rows[0] ? toTrack(rows[0]) : null;
}

export async function setEntry(cardId: number, e: { entryDate: string; entryPrice: number; spyEntry: number | null; sectorEntry: number | null }): Promise<void> {
  await q(`UPDATE tracks SET entry_date = $2, entry_price = $3, spy_entry = $4, sector_entry = $5 WHERE card_id = $1 AND entry_date IS NULL`, [cardId, e.entryDate, e.entryPrice, e.spyEntry, e.sectorEntry]);
}

export async function setExit(cardId: number, x: { exitDate: string; exitPrice: number; spyExit: number | null; sectorExit: number | null; reason: string; maxDrawdownPct: number | null }): Promise<void> {
  await q(`UPDATE tracks SET exit_date = $2, exit_price = $3, spy_exit = $4, sector_exit = $5, exit_reason = $6, max_drawdown_pct = $7 WHERE card_id = $1 AND exit_date IS NULL`, [cardId, x.exitDate, x.exitPrice, x.spyExit, x.sectorExit, x.reason, x.maxDrawdownPct]);
}

export async function setDrawdown(cardId: number, dd: number): Promise<void> {
  await q(`UPDATE tracks SET max_drawdown_pct = $2 WHERE card_id = $1`, [cardId, dd]);
}

export async function setTapped(cardId: number, response: unknown): Promise<void> {
  await q(`UPDATE tracks SET tapped_at = coalesce(tapped_at, now()), swing_response = $2 WHERE card_id = $1`, [cardId, JSON.stringify(response)]);
}

export async function addTrackEvent(cardId: number, kind: "invalidated" | "sent_to_swing" | "send_failed", detail: string | null): Promise<void> {
  await q(`INSERT INTO track_events (card_id, kind, detail) VALUES ($1, $2, $3)`, [cardId, kind, detail]);
}

export async function trackEvents(): Promise<Array<{ cardId: number; kind: string; at: string; detail: string | null }>> {
  return (await q(`SELECT card_id, kind, at, detail FROM track_events ORDER BY id`)).map((r) => ({ cardId: Number(r.card_id), kind: r.kind, at: iso(r.at)!, detail: r.detail }));
}

// -------------------------------------------------------------- daily bars

export interface DailyBarRow { symbol: string; date: string; o: number; h: number; l: number; c: number; v: number }

export async function upsertBars(bars: DailyBarRow[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < bars.length; i += 2000) {
    const c = bars.slice(i, i + 2000);
    const rows = await q(
      `INSERT INTO daily_bars (symbol, date, o, h, l, c, v) SELECT * FROM unnest($1::text[], $2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::bigint[])
       ON CONFLICT (symbol, date) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v RETURNING 1`,
      [c.map((b) => b.symbol), c.map((b) => b.date), c.map((b) => b.o), c.map((b) => b.h), c.map((b) => b.l), c.map((b) => b.c), c.map((b) => Math.round(b.v))],
    );
    n += rows.length;
  }
  return n;
}

export async function loadBars(symbols: string[], from: string, to: string): Promise<DailyBarRow[]> {
  if (!symbols.length) return [];
  const rows = await q(`SELECT symbol, date, o, h, l, c, v FROM daily_bars WHERE symbol = ANY($1) AND date >= $2 AND date <= $3 ORDER BY symbol, date`, [symbols, from, to]);
  return rows.map((r) => ({ symbol: r.symbol, date: dstr(r.date)!, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
}

export async function lastBarDate(symbol: string): Promise<string | null> {
  return dstr((await q(`SELECT max(date) AS d FROM daily_bars WHERE symbol = $1`, [symbol]))[0]?.d);
}

// ------------------------------------------------------- ticker news counts

export async function saveTickerCounts(date: string, items: Array<{ symbols: string[]; source: string; url: string }>): Promise<void> {
  const { isMainstream } = await import("../sources/news");
  const by = new Map<string, { stories: number; mainstream: number }>();
  for (const n of items) {
    if (n.symbols.length > 6) continue;
    const main = isMainstream(n as never);
    for (const sym of n.symbols) {
      const c = by.get(sym) ?? { stories: 0, mainstream: 0 };
      c.stories++;
      if (main) c.mainstream++;
      by.set(sym, c);
    }
  }
  const rows = [...by.entries()];
  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i + 500);
    await q(
      `INSERT INTO ticker_news_daily (date, symbol, stories, mainstream) SELECT $1::date, * FROM unnest($2::text[], $3::int[], $4::int[])
       ON CONFLICT (date, symbol) DO UPDATE SET stories = greatest(ticker_news_daily.stories, excluded.stories), mainstream = greatest(ticker_news_daily.mainstream, excluded.mainstream)`,
      [date, c.map(([s]) => s), c.map(([, v]) => v.stories), c.map(([, v]) => v.mainstream)],
    );
  }
}

/** Average stories per day per ticker over [from, to), over the days with any coverage. */
export async function tickerDailyAverages(from: string, to: string): Promise<Record<string, number>> {
  const rows = await q(`SELECT symbol, avg(stories) AS avg, count(*) AS n FROM ticker_news_daily WHERE date >= $1 AND date < $2 GROUP BY symbol HAVING count(*) >= 5`, [from, to]);
  return Object.fromEntries(rows.map((r) => [r.symbol, Number(r.avg)]));
}

// --------------------------------------------------------------- llm spend

export async function logLlmCall(c: { etDate: string; model: string; purpose: string; usage: unknown; costUsd: number | null; ok: boolean }): Promise<void> {
  await q(`INSERT INTO llm_calls (et_date, model, purpose, usage, cost_usd, ok) VALUES ($1, $2, $3, $4, $5, $6)`, [c.etDate, c.model, c.purpose, JSON.stringify(c.usage ?? null), c.costUsd, c.ok]);
}

export async function spendOn(etDate: string): Promise<{ cost: number; calls: number }> {
  const r = (await q(`SELECT coalesce(sum(cost_usd), 0) AS cost, count(*) AS calls FROM llm_calls WHERE et_date = $1`, [etDate]))[0];
  return { cost: Number(r.cost), calls: Number(r.calls) };
}

export async function spendByDay(days = 30): Promise<Array<{ date: string; cost: number; calls: number }>> {
  const rows = await q(`SELECT et_date, sum(cost_usd) AS cost, count(*) AS calls FROM llm_calls WHERE et_date >= current_date - $1::int GROUP BY et_date ORDER BY et_date DESC`, [days]);
  return rows.map((r) => ({ date: dstr(r.et_date)!, cost: Number(r.cost ?? 0), calls: Number(r.calls) }));
}

// -------------------------------------------------------------------- runs

export async function startRun(action: string): Promise<number> {
  return Number((await q(`INSERT INTO runs (action, status) VALUES ($1, 'running') RETURNING id`, [action]))[0].id);
}

export async function finishRun(id: number, status: "ok" | "skipped" | "error", detail: unknown, error?: string): Promise<void> {
  await q(`UPDATE runs SET finished_at = now(), status = $2, detail = $3, error = $4 WHERE id = $1`, [id, status, JSON.stringify(detail ?? null), error ?? null]);
}

export async function recentRuns(limit = 20): Promise<Array<{ id: number; action: string; startedAt: string; finishedAt: string | null; status: string; detail: unknown; error: string | null }>> {
  return (await q(`SELECT * FROM runs ORDER BY id DESC LIMIT $1`, [limit])).map((r) => ({ id: Number(r.id), action: r.action, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), status: r.status, detail: r.detail, error: r.error }));
}

export async function lastRun(action: string): Promise<{ startedAt: string; status: string } | null> {
  const r = (await q(`SELECT started_at, status FROM runs WHERE action = $1 AND status <> 'running' ORDER BY id DESC LIMIT 1`, [action]))[0];
  return r ? { startedAt: iso(r.started_at)!, status: r.status } : null;
}

// ------------------------------------------------------------------ emails

export async function claimEmail(key: string, subject: string): Promise<boolean> {
  return (await q(`INSERT INTO emails_sent (key, subject) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING 1`, [key, subject])).length > 0;
}

export async function releaseEmail(key: string): Promise<void> {
  await q(`DELETE FROM emails_sent WHERE key = $1`, [key]);
}
