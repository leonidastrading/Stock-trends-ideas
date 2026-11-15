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
  notifyPromoted: boolean;
  notifyStories: boolean;
  notifyReviews: boolean;
  /** Approve the scout's proposed watch-list terms automatically, and retire its quiet ones after 30 days. */
  autoApproveTerms: boolean;
}

export const DEFAULT_SETTINGS: ScoutSettings = {
  enabled: true, model: SCOUT.defaultModel, effort: SCOUT.defaultEffort, dailyCapUsd: SCOUT.defaultDailyCapUsd, maxCandidatesPerScan: SCOUT.maxCandidatesPerScan, discoveryPerScan: SCOUT.discoveryPerScan, emailDigest: true, notifyPromoted: true, notifyStories: true, notifyReviews: true, autoApproveTerms: true,
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

/** Versions whose reply schema defines confidence as a probability of beating SPY (calibration only counts these). */
export async function calibratedVersionIds(): Promise<Set<number>> {
  return new Set((await q(`SELECT id FROM scout_versions WHERE spec::text LIKE '%probability the primary ticker%'`)).map((r) => Number(r.id)));
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
  /** Set when the track was excluded from scoring (it followed the wrong security): the reason. */
  excluded?: string | null;
}

const toTrack = (r: Row): Track => ({
  cardId: Number(r.card_id), symbol: r.symbol, sectorEtf: r.sector_etf, direction: r.direction, cardDate: dstr(r.card_date)!, entryDate: dstr(r.entry_date), entryPrice: num(r.entry_price), spyEntry: num(r.spy_entry), sectorEntry: num(r.sector_entry),
  deadlineDate: dstr(r.deadline_date)!, exitDate: dstr(r.exit_date), exitPrice: num(r.exit_price), spyExit: num(r.spy_exit), sectorExit: num(r.sector_exit), exitReason: r.exit_reason, maxDrawdownPct: num(r.max_drawdown_pct), tappedAt: iso(r.tapped_at), swingResponse: r.swing_response,
  excluded: r.excluded ?? null,
});

const TRACK_SELECT = `SELECT t.*, (SELECT e.detail FROM track_events e WHERE e.card_id = t.card_id AND e.kind = 'excluded' ORDER BY e.id LIMIT 1) AS excluded FROM tracks t`;

export async function insertTrack(t: { cardId: number; symbol: string; sectorEtf: string; direction: "long" | "short"; cardDate: string; deadlineDate: string }): Promise<void> {
  await q(`INSERT INTO tracks (card_id, symbol, sector_etf, direction, card_date, deadline_date) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (card_id) DO NOTHING`, [t.cardId, t.symbol, t.sectorEtf, t.direction, t.cardDate, t.deadlineDate]);
}

export async function allTracks(): Promise<Track[]> {
  return (await q(`${TRACK_SELECT} ORDER BY t.card_id`)).map(toTrack);
}

export async function getTrack(cardId: number): Promise<Track | null> {
  const rows = await q(`${TRACK_SELECT} WHERE t.card_id = $1`, [cardId]);
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

export async function addTrackEvent(cardId: number, kind: "invalidated" | "sent_to_swing" | "send_failed" | "excluded", detail: string | null): Promise<void> {
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

// ---------------------------------------------------------------- feedback

export interface Feedback { id: number; at: string; target: string; vote: "up" | "down"; note: string | null }

export async function addFeedback(target: string, vote: "up" | "down", note: string | null): Promise<void> {
  await q(`INSERT INTO feedback (target, vote, note) VALUES ($1, $2, $3)`, [target, vote, note]);
}

/** Latest reaction per target. */
export async function latestFeedback(): Promise<Map<string, Feedback>> {
  const rows = await q(`SELECT DISTINCT ON (target) id, at, target, vote, note FROM feedback ORDER BY target, id DESC`);
  return new Map(rows.map((r) => [r.target, { id: Number(r.id), at: iso(r.at)!, target: r.target, vote: r.vote, note: r.note }]));
}

/** Recent reactions with what they were about, newest first, for the prompts and the Settings page. */
export async function recentFeedback(limit = 40): Promise<Array<Feedback & { about: string }>> {
  const rows = await q(
    `SELECT f.id, f.at, f.target, f.vote, f.note,
            CASE WHEN f.target LIKE 'card:%' THEN c.title || ' [' || c.kind || ', ' || c.direction || ' ' || c.primary_ticker || ']' ELSE replace(f.target, 'story:', 'story ') END AS about
     FROM (SELECT DISTINCT ON (target) * FROM feedback ORDER BY target, id DESC) f
     LEFT JOIN cards c ON f.target = 'card:' || c.id
     ORDER BY f.id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: Number(r.id), at: iso(r.at)!, target: r.target, vote: r.vote, note: r.note, about: r.about ?? r.target }));
}

// ----------------------------------------------------------------- reviews

export interface StoredReview { cardId: number; createdAt: string; verdict: string; summary: string; evidence: Array<{ date: string; source: string; headline: string }>; moveSinceEntryPct: number | null }

const toReview = (r: Row): StoredReview => ({ cardId: Number(r.card_id), createdAt: iso(r.created_at)!, verdict: r.verdict, summary: r.summary, evidence: r.evidence ?? [], moveSinceEntryPct: num(r.move_since_entry_pct) });

export async function insertReview(r: { cardId: number; verdict: string; summary: string; evidence: unknown; moveSinceEntryPct: number | null; model: string }): Promise<void> {
  await q(`INSERT INTO catalyst_reviews (card_id, verdict, summary, evidence, move_since_entry_pct, model) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (card_id) DO NOTHING`, [r.cardId, r.verdict, r.summary, JSON.stringify(r.evidence ?? []), r.moveSinceEntryPct, r.model]);
}

export async function reviewedCardIds(): Promise<Set<number>> {
  return new Set((await q(`SELECT card_id FROM catalyst_reviews`)).map((r) => Number(r.card_id)));
}

export async function getReview(cardId: number): Promise<StoredReview | null> {
  const r = (await q(`SELECT * FROM catalyst_reviews WHERE card_id = $1`, [cardId]))[0];
  return r ? toReview(r) : null;
}

export async function allReviews(): Promise<Map<number, StoredReview>> {
  return new Map((await q(`SELECT * FROM catalyst_reviews`)).map((r) => [Number(r.card_id), toReview(r)]));
}

// ----------------------------------------------------------- notifications

/** Claim a push; false if it was already sent. */
export async function claimNotification(key: string, title: string): Promise<boolean> {
  return (await q(`INSERT INTO notifications (key, title) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING 1`, [key, title])).length > 0;
}

export async function countNotifications(prefix: string): Promise<number> {
  return Number((await q(`SELECT count(*) AS n FROM notifications WHERE key LIKE $1`, [`${prefix}%`]))[0]?.n ?? 0);
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

/** Daily story counts for some tickers over [from, to]. */
export async function tickerCounts(symbols: string[], from: string, to: string): Promise<Array<{ date: string; symbol: string; stories: number; mainstream: number }>> {
  if (!symbols.length) return [];
  const rows = await q(`SELECT date, symbol, stories, mainstream FROM ticker_news_daily WHERE symbol = ANY($1::text[]) AND date >= $2 AND date <= $3 ORDER BY date`, [symbols, from, to]);
  return rows.map((r) => ({ date: dstr(r.date)!, symbol: r.symbol, stories: Number(r.stories), mainstream: Number(r.mainstream) }));
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

export async function runsByAction(action: string, limit = 50): Promise<Array<{ id: number; startedAt: string; finishedAt: string | null; status: string; detail: unknown; error: string | null }>> {
  return (await q(`SELECT * FROM runs WHERE action = $1 ORDER BY id DESC LIMIT $2`, [action, limit])).map((r) => ({ id: Number(r.id), startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), status: r.status, detail: r.detail, error: r.error }));
}

/** When a job last started, finished or not. */
export async function lastStarted(action: string): Promise<string | null> {
  const r = (await q(`SELECT started_at FROM runs WHERE action = $1 ORDER BY id DESC LIMIT 1`, [action]))[0];
  return r ? iso(r.started_at) : null;
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

// ------------------------------------------------------------ story timeline

export interface StoryEvent { id: number; createdAt: string; etDate: string; key: string; symbols: string[]; stage: number; summary: string; escalation: string[]; company: string | null; people: string[] }

const toStoryEvent = (r: Row): StoryEvent => ({ id: Number(r.id), createdAt: iso(r.created_at)!, etDate: dstr(r.et_date)!, key: r.key, symbols: r.symbols ?? [], stage: Number(r.stage), summary: r.summary, escalation: r.escalation ?? [], company: r.company ?? null, people: r.people ?? [] });

/** Story stages read since `from` (ET date), oldest first. */
export async function storyEventsSince(from: string): Promise<StoryEvent[]> {
  return (await q(`SELECT * FROM story_events WHERE et_date >= $1 ORDER BY et_date, id`, [from])).map(toStoryEvent);
}

/** Record that the desk read a story today; once per key per day (later reads the same day are ignored). */
export async function addStoryEvent(e: { etDate: string; key: string; symbols: string[]; stage: number; summary: string; escalation: string[]; company?: string | null; people?: string[]; labels?: unknown }): Promise<void> {
  await q(`INSERT INTO story_events (et_date, key, symbols, stage, summary, escalation, company, people, labels) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (key, et_date) DO NOTHING`, [e.etDate, e.key, e.symbols, e.stage, e.summary, e.escalation, e.company ?? null, e.people ?? [], e.labels ? JSON.stringify(e.labels) : null]);
}

// ------------------------------------------------------------ chatter test

export interface ChatterDay { date: string; symbol: string; measuredAt: string; perHour: number; sampled: number; spanHours: number; bullishShare: number | null; watchers: number | null; trendingRank: number | null }
export interface ChatterEvent { id: number; createdAt: string; date: string; symbol: string; kind: "spike" | "control"; z: number | null; perHour: number; baselinePerHour: number | null; bullishShare: number | null }

const toChatterDay = (r: Row): ChatterDay => ({ date: dstr(r.date)!, symbol: r.symbol, measuredAt: iso(r.measured_at)!, perHour: Number(r.per_hour), sampled: Number(r.sampled), spanHours: Number(r.span_hours), bullishShare: num(r.bullish_share), watchers: num(r.watchers), trendingRank: num(r.trending_rank) });

export async function chatterMeasuredOn(date: string): Promise<Set<string>> {
  return new Set((await q(`SELECT symbol FROM chatter_daily WHERE date = $1`, [date])).map((r) => r.symbol));
}

/** A symbol's measurements before `date`, oldest first (at most `limit`, the most recent). */
export async function chatterHistory(symbol: string, date: string, limit: number): Promise<ChatterDay[]> {
  return (await q(`SELECT * FROM (SELECT * FROM chatter_daily WHERE symbol = $1 AND date < $2 ORDER BY date DESC LIMIT $3) x ORDER BY date`, [symbol, date, limit])).map(toChatterDay);
}

export async function addChatterDay(d: Omit<ChatterDay, "measuredAt">): Promise<void> {
  await q(`INSERT INTO chatter_daily (date, symbol, per_hour, sampled, span_hours, bullish_share, watchers, trending_rank) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (date, symbol) DO NOTHING`, [d.date, d.symbol, d.perHour, d.sampled, d.spanHours, d.bullishShare, d.watchers, d.trendingRank]);
}

export async function addChatterEvent(e: Omit<ChatterEvent, "id" | "createdAt">): Promise<void> {
  await q(`INSERT INTO chatter_events (date, symbol, kind, z, per_hour, baseline_per_hour, bullish_share) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (date, symbol, kind) DO NOTHING`, [e.date, e.symbol, e.kind, e.z, e.perHour, e.baselinePerHour, e.bullishShare]);
}

export async function chatterSpikeSince(symbol: string, from: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM chatter_events WHERE symbol = $1 AND kind = 'spike' AND date >= $2 LIMIT 1`, [symbol, from])).length > 0;
}

export async function chatterEvents(): Promise<ChatterEvent[]> {
  return (await q(`SELECT * FROM chatter_events ORDER BY date, symbol`)).map((r) => ({ id: Number(r.id), createdAt: iso(r.created_at)!, date: dstr(r.date)!, symbol: r.symbol, kind: r.kind, z: num(r.z), perHour: Number(r.per_hour), baselinePerHour: num(r.baseline_per_hour), bullishShare: num(r.bullish_share) }));
}

export async function chatterStatus(): Promise<{ days: number; firstDate: string | null; lastDate: string | null; rows: number; lastDayCount: number }> {
  const r = (await q(`SELECT count(DISTINCT date) AS days, min(date) AS first, max(date) AS last, count(*) AS rows FROM chatter_daily`))[0] ?? {};
  const last = dstr(r.last);
  const n = last ? Number((await q(`SELECT count(*) AS n FROM chatter_daily WHERE date = $1`, [last]))[0]?.n ?? 0) : 0;
  return { days: Number(r.days ?? 0), firstDate: dstr(r.first), lastDate: last, rows: Number(r.rows ?? 0), lastDayCount: n };
}

export async function addEarningsDates(symbol: string, dates: string[]): Promise<void> {
  if (dates.length) await q(`INSERT INTO earnings_dates (symbol, date) SELECT $1, unnest($2::date[]) ON CONFLICT DO NOTHING`, [symbol, dates]);
}

export async function earningsDatesBySymbol(): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  for (const r of await q(`SELECT symbol, date FROM earnings_dates ORDER BY symbol, date`)) m.set(r.symbol, [...(m.get(r.symbol) ?? []), dstr(r.date)!]);
  return m;
}

// ------------------------------------------------------------ symbol info

export interface SymbolInfo { symbol: string; name: string | null; exchange: string | null; tradable: boolean | null; lastEarnings: string | null; nextEarnings: string | null; nextBasis: string | null; checkedAt: string }

const toSymbolInfo = (r: Row): SymbolInfo => ({ symbol: r.symbol, name: r.name ?? null, exchange: r.exchange ?? null, tradable: r.tradable ?? null, lastEarnings: dstr(r.last_earnings), nextEarnings: dstr(r.next_earnings), nextBasis: r.next_basis ?? null, checkedAt: iso(r.checked_at)! });

export async function upsertSymbolInfo(i: Omit<SymbolInfo, "checkedAt">): Promise<void> {
  await q(
    `INSERT INTO symbol_info (symbol, name, exchange, tradable, last_earnings, next_earnings, next_basis, checked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (symbol) DO UPDATE SET name = COALESCE(excluded.name, symbol_info.name), exchange = COALESCE(excluded.exchange, symbol_info.exchange), tradable = COALESCE(excluded.tradable, symbol_info.tradable),
       last_earnings = COALESCE(excluded.last_earnings, symbol_info.last_earnings),
       next_earnings = CASE WHEN symbol_info.next_basis LIKE 'confirmed%' AND symbol_info.next_earnings >= current_date THEN symbol_info.next_earnings ELSE COALESCE(excluded.next_earnings, symbol_info.next_earnings) END,
       next_basis = CASE WHEN symbol_info.next_basis LIKE 'confirmed%' AND symbol_info.next_earnings >= current_date THEN symbol_info.next_basis ELSE COALESCE(excluded.next_basis, symbol_info.next_basis) END,
       checked_at = now()`,
    [i.symbol, i.name, i.exchange, i.tradable, i.lastEarnings, i.nextEarnings, i.nextBasis],
  );
}

export async function symbolInfo(symbols: string[]): Promise<Map<string, SymbolInfo>> {
  if (!symbols.length) return new Map();
  return new Map((await q(`SELECT * FROM symbol_info WHERE symbol = ANY($1::text[])`, [symbols])).map((r) => [r.symbol, toSymbolInfo(r)]));
}

/** Symbols checked within the last `hours`. */
export async function freshSymbols(hours: number): Promise<Set<string>> {
  return new Set((await q(`SELECT symbol FROM symbol_info WHERE checked_at >= now() - ($1::int * interval '1 hour')`, [hours])).map((r) => r.symbol));
}

/** Which symbols had stories on which days, and which days the news stream was recorded at all. */
export async function newsDays(from: string, to: string): Promise<{ bySymbol: Map<string, Set<string>>; recorded: Set<string> }> {
  const rows = await q(`SELECT date, symbol FROM ticker_news_daily WHERE date >= $1 AND date <= $2 AND stories > 0`, [from, to]);
  const bySymbol = new Map<string, Set<string>>();
  const recorded = new Set<string>();
  for (const r of rows) {
    const d = dstr(r.date)!;
    recorded.add(d);
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Set());
    bySymbol.get(r.symbol)!.add(d);
  }
  return { bySymbol, recorded };
}

// ------------------------------------------------------------ SEC filings

export async function secIndexLoaded(dates: string[]): Promise<Set<string>> {
  if (!dates.length) return new Set();
  return new Set((await q(`SELECT date FROM sec_index_days WHERE date = ANY($1::date[])`, [dates])).map((r) => dstr(r.date)!));
}

export async function addSecIndex(date: string, entries: Array<{ accession: string; form: string; cik: string; company: string; filed: string; path: string }>): Promise<void> {
  for (let i = 0; i < entries.length; i += 500) {
    const c = entries.slice(i, i + 500);
    await q(
      `INSERT INTO sec_queue (accession, form, cik, company, filed, path) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::date[], $6::text[]) ON CONFLICT (accession) DO NOTHING`,
      [c.map((e) => e.accession), c.map((e) => e.form), c.map((e) => e.cik), c.map((e) => e.company), c.map((e) => e.filed), c.map((e) => e.path)],
    );
  }
  await q(`INSERT INTO sec_index_days (date, entries) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING`, [date, entries.length]);
}

export interface QueuedFiling { accession: string; form: string; cik: string; company: string; filed: string; path: string }

/** Filings still to look at: 13Ds first, then 8-Ks, then Form 4s; newest first. */
export async function secQueue(limit: number): Promise<QueuedFiling[]> {
  return (await q(`SELECT accession, form, cik, company, filed, path FROM sec_queue WHERE status = 'new' ORDER BY CASE WHEN form LIKE '%13D%' THEN 0 WHEN form = '8-K' THEN 1 ELSE 2 END, filed DESC LIMIT $1`, [limit]))
    .map((r) => ({ accession: r.accession, form: r.form, cik: r.cik, company: r.company, filed: dstr(r.filed)!, path: r.path }));
}

export async function secDone(accession: string, status: "done" | "error", note: string | null = null): Promise<void> {
  await q(`UPDATE sec_queue SET status = $2, note = $3, processed_at = now() WHERE accession = $1`, [accession, status, note]);
}

export async function secQueueStatus(): Promise<{ pending: number; done: number; errors: number; days: string[] }> {
  const r = (await q(`SELECT count(*) FILTER (WHERE status = 'new') AS pending, count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'error') AS errors FROM sec_queue`))[0] ?? {};
  const days = (await q(`SELECT date FROM sec_index_days ORDER BY date DESC LIMIT 10`)).map((x) => dstr(x.date)!);
  return { pending: Number(r.pending ?? 0), done: Number(r.done ?? 0), errors: Number(r.errors ?? 0), days };
}

export interface InsiderBuyRow { accession: string; filed: string; issuerCik: string | null; symbol: string | null; issuerName: string | null; owner: string | null; ownerCik: string | null; role: string | null; txDate: string | null; shares: number | null; price: number | null; value: number | null; ownedAfter: number | null; pctIncrease: number | null; plan10b5: boolean | null; routine: boolean | null }

export async function addInsiderBuy(b: InsiderBuyRow): Promise<void> {
  await q(`INSERT INTO insider_buys (accession, filed, issuer_cik, symbol, issuer_name, owner, owner_cik, role, tx_date, shares, price, value, owned_after, pct_increase, plan10b5, routine) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (accession) DO NOTHING`,
    [b.accession, b.filed, b.issuerCik, b.symbol, b.issuerName, b.owner, b.ownerCik, b.role, b.txDate, b.shares, b.price, b.value, b.ownedAfter, b.pctIncrease, b.plan10b5, b.routine]);
}

export async function insiderBuysSince(from: string): Promise<InsiderBuyRow[]> {
  return (await q(`SELECT * FROM insider_buys WHERE filed >= $1 ORDER BY filed DESC, value DESC`, [from])).map((r) => ({
    accession: r.accession, filed: dstr(r.filed)!, issuerCik: r.issuer_cik, symbol: r.symbol, issuerName: r.issuer_name, owner: r.owner, ownerCik: r.owner_cik, role: r.role, txDate: dstr(r.tx_date),
    shares: num(r.shares), price: num(r.price), value: num(r.value), ownedAfter: num(r.owned_after), pctIncrease: num(r.pct_increase), plan10b5: r.plan10b5 ?? null, routine: r.routine ?? null,
  }));
}

export interface FilingAlert { accession: string; kind: "8-K" | "13D"; filed: string; cik: string | null; symbol: string | null; company: string | null; items: string[]; filer: string | null }

export async function addFilingAlert(a: FilingAlert): Promise<void> {
  await q(`INSERT INTO filing_alerts (accession, kind, filed, cik, symbol, company, items, filer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (accession) DO NOTHING`, [a.accession, a.kind, a.filed, a.cik, a.symbol, a.company, a.items, a.filer]);
}

export async function filingAlertsSince(from: string): Promise<FilingAlert[]> {
  return (await q(`SELECT * FROM filing_alerts WHERE filed >= $1 ORDER BY filed DESC`, [from])).map((r) => ({ accession: r.accession, kind: r.kind, filed: dstr(r.filed)!, cik: r.cik, symbol: r.symbol, company: r.company, items: r.items ?? [], filer: r.filer }));
}

// ------------------------------------------------------------ GitHub inbox

export async function inboxSeen(): Promise<Set<string>> {
  return new Set((await q(`SELECT path, sha FROM inbox_files`)).map((r) => `${r.path}@${r.sha}`));
}

export async function markInbox(path: string, sha: string, result: unknown, text: string | null = null): Promise<void> {
  await q(`INSERT INTO inbox_files (path, sha, result, text) VALUES ($1, $2, $3, $4) ON CONFLICT (path, sha) DO NOTHING`, [path, sha, JSON.stringify(result), text]);
}

/** Documents read since `from`, newest first, with their text where it was kept. */
export async function inboxDocsSince(from: string): Promise<Array<{ path: string; sha: string; readAt: string; text: string | null; result: Record<string, unknown> | null }>> {
  return (await q(`SELECT path, sha, read_at, text, result FROM inbox_files WHERE read_at >= $1 ORDER BY read_at DESC`, [from])).map((r) => ({ path: r.path, sha: r.sha, readAt: iso(r.read_at)!, text: r.text ?? null, result: r.result ?? null }));
}

export async function setInboxText(path: string, sha: string, text: string): Promise<void> {
  await q(`UPDATE inbox_files SET text = $3 WHERE path = $1 AND sha = $2`, [path, sha, text]);
}

export async function addInboxDigest(docs: string[], digest: unknown, costUsd: number | null): Promise<void> {
  await q(`INSERT INTO inbox_digests (docs, digest, cost_usd) VALUES ($1, $2, $3)`, [docs, JSON.stringify(digest), costUsd]);
}

export async function latestInboxDigest<T>(): Promise<{ createdAt: string; docs: string[]; digest: T } | null> {
  const r = (await q(`SELECT created_at, docs, digest FROM inbox_digests ORDER BY id DESC LIMIT 1`))[0];
  return r ? { createdAt: iso(r.created_at)!, docs: r.docs ?? [], digest: r.digest as T } : null;
}

export async function inboxRecent(limit = 50): Promise<Array<{ path: string; readAt: string; result: Record<string, unknown> | null }>> {
  return (await q(`SELECT path, read_at, result FROM inbox_files ORDER BY read_at DESC LIMIT $1`, [limit])).map((r) => ({ path: r.path, readAt: iso(r.read_at)!, result: r.result ?? null }));
}

// ------------------------------------------------------------ dashboard cache

export async function cacheGet<T>(key: string): Promise<{ data: T; updatedAt: string } | null> {
  const r = (await q(`SELECT data, updated_at FROM dashboard_cache WHERE key = $1`, [key]))[0];
  return r ? { data: r.data as T, updatedAt: iso(r.updated_at)! } : null;
}

export async function cachePut(key: string, data: unknown): Promise<void> {
  await q(`INSERT INTO dashboard_cache (key, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = now()`, [key, JSON.stringify(data)]);
}

/** A dated earnings release from a calendar replaces the estimate, for symbols the scout already shows. */
export async function confirmEarnings(symbol: string, date: string, basis: string): Promise<void> {
  await q(`UPDATE symbol_info SET next_earnings = $2, next_basis = $3 WHERE symbol = $1`, [symbol, date, basis]);
}

/** Inputs for the buzz score: the latest chatter measurement per symbol with its history, and news counts against their usual pace. */
export async function buzzInputs(): Promise<Array<{ symbol: string; perHour: number; history: number[]; trendingRank: number | null; news: number | null; newsAvg: number | null }>> {
  const last = dstr((await q(`SELECT max(date) AS d FROM chatter_daily`))[0]?.d);
  const newsDay = dstr((await q(`SELECT max(date) AS d FROM ticker_news_daily`))[0]?.d);
  const news = new Map<string, number>();
  const avg = new Map<string, number>();
  if (newsDay) {
    for (const r of await q(`SELECT symbol, stories FROM ticker_news_daily WHERE date = $1`, [newsDay])) news.set(r.symbol, Number(r.stories));
    for (const r of await q(`SELECT symbol, avg(stories) AS a FROM ticker_news_daily WHERE date < $1 AND date >= ($1::date - 30) GROUP BY symbol`, [newsDay])) avg.set(r.symbol, Number(r.a));
  }
  const out = new Map<string, { symbol: string; perHour: number; history: number[]; trendingRank: number | null; news: number | null; newsAvg: number | null }>();
  if (last) {
    for (const r of await q(`SELECT symbol, per_hour, trending_rank FROM chatter_daily WHERE date = $1`, [last])) out.set(r.symbol, { symbol: r.symbol, perHour: Number(r.per_hour), history: [], trendingRank: num(r.trending_rank), news: news.get(r.symbol) ?? null, newsAvg: avg.get(r.symbol) ?? null });
    for (const r of await q(`SELECT symbol, per_hour FROM chatter_daily WHERE date < $1 AND date >= ($1::date - 90) ORDER BY date`, [last])) out.get(r.symbol)?.history.push(Number(r.per_hour));
  }
  for (const [symbol, n] of news) if (!out.has(symbol) && n >= 3) out.set(symbol, { symbol, perHour: 0, history: [], trendingRank: null, news: n, newsAvg: avg.get(symbol) ?? null });
  return [...out.values()];
}

// ------------------------------------------------------------ Congress trades

export interface CongressTradeRow { docId: string; ord: number; chamber: string; member: string; stateDst: string | null; filed: string; owner: string; symbol: string; assetType: string; tx: string; txDate: string; notified: string | null; amountLow: number | null; amountHigh: number | null; amount: string; year?: number }

export async function congressSeen(): Promise<Set<string>> {
  return new Set((await q(`SELECT doc_id FROM congress_filings`)).map((r) => String(r.doc_id)));
}

/** One report: its trades first, then the read record (so a crash between the two re-reads the report; trades are keyed and skipped). */
export async function addCongressFiling(f: { docId: string; chamber: string; member: string; stateDst: string | null; filed: string; year: number; status: string }, trades: CongressTradeRow[]): Promise<void> {
  for (const t of trades) {
    await q(`INSERT INTO congress_trades (doc_id, ord, chamber, member, state_dst, filed, owner, symbol, asset_type, tx, tx_date, notified, amount_low, amount_high, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (doc_id, ord) DO NOTHING`,
      [t.docId, t.ord, t.chamber, t.member, t.stateDst, t.filed, t.owner, t.symbol, t.assetType, t.tx, t.txDate, t.notified, t.amountLow, t.amountHigh, t.amount]);
  }
  await q(`INSERT INTO congress_filings (doc_id, chamber, member, state_dst, filed, year, status, trades) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (doc_id) DO NOTHING`, [f.docId, f.chamber, f.member, f.stateDst, f.filed, f.year, f.status, trades.length]);
}

export async function congressTradesSince(from: string): Promise<CongressTradeRow[]> {
  return (await q(`SELECT t.*, f.year FROM congress_trades t LEFT JOIN congress_filings f USING (doc_id) WHERE t.filed >= $1 ORDER BY t.filed DESC, t.doc_id DESC, t.ord`, [from])).map((r) => ({
    docId: r.doc_id, ord: Number(r.ord), chamber: r.chamber, member: r.member, stateDst: r.state_dst ?? null, filed: dstr(r.filed)!, owner: r.owner, symbol: r.symbol, assetType: r.asset_type, tx: r.tx,
    txDate: dstr(r.tx_date)!, notified: dstr(r.notified), amountLow: num(r.amount_low), amountHigh: num(r.amount_high), amount: r.amount, year: r.year === null || r.year === undefined ? undefined : Number(r.year),
  }));
}

export async function congressFilingsStatus(): Promise<{ read: number; withTrades: number; scanned: number; errors: number; latest: string | null }> {
  const r = (await q(`SELECT count(*) AS read, count(*) FILTER (WHERE trades > 0) AS with_trades, count(*) FILTER (WHERE status LIKE 'scanned%') AS scanned, count(*) FILTER (WHERE status LIKE 'error%') AS errors, max(filed) AS latest FROM congress_filings`))[0] ?? {};
  return { read: Number(r.read ?? 0), withTrades: Number(r.with_trades ?? 0), scanned: Number(r.scanned ?? 0), errors: Number(r.errors ?? 0), latest: dstr(r.latest) };
}

// ------------------------------------------------------------ locks

/** Atomic: take `key` unless someone else took it less than `ttlMin` minutes ago (a crashed holder's lock expires). */
export async function tryLock(key: string, ttlMin: number): Promise<boolean> {
  const r = await q(`INSERT INTO dashboard_cache (key, data, updated_at) VALUES ($1, '{}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE dashboard_cache.updated_at < now() - make_interval(mins => $2) RETURNING key`, [key, ttlMin]);
  return r.length > 0;
}

export async function unlock(key: string): Promise<void> {
  await q(`DELETE FROM dashboard_cache WHERE key = $1`, [key]);
}

// ------------------------------------------------------------ options positioning

export async function optionsSnapshot(symbol: string): Promise<{ date: string; spot: number; oi: Record<string, number> } | null> {
  const r = (await q(`SELECT date, spot, oi FROM options_oi WHERE symbol = $1`, [symbol]))[0];
  return r ? { date: dstr(r.date)!, spot: Number(r.spot), oi: r.oi as Record<string, number> } : null;
}

export async function optionsCapturedOn(date: string): Promise<Set<string>> {
  return new Set((await q(`SELECT symbol FROM options_oi WHERE date = $1`, [date])).map((r) => String(r.symbol)));
}

export interface OptionsDay { symbol: string; date: string; prevDate: string | null; contracts: number; callOi: number; putOi: number; p95Up: number | null; maxUp: number | null }

/** One stock's day: its summary and flags (append-only), then the snapshot the next day is compared with. */
export async function saveOptionsDay(day: OptionsDay, spot: number, oi: Record<string, number>, flags: OptionsFlag[]): Promise<void> {
  if (day.prevDate) {
    await q(`INSERT INTO options_oi_days (symbol, date, prev_date, contracts, call_oi, put_oi, p95_up, max_up) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (symbol, date) DO NOTHING`,
      [day.symbol, day.date, day.prevDate, day.contracts, day.callOi, day.putOi, day.p95Up, day.maxUp]);
  }
  for (const f of flags) {
    await q(`INSERT INTO options_flags (date, contract, symbol, type, strike, expiry, prev_oi, oi, spot, mid, volume, premium_usd, notional_usd, baseline, multiple, structure) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (date, contract) DO NOTHING`,
      [f.date, f.contract, f.symbol, f.type, f.strike, f.expiry, f.prevOi, f.oi, f.spot, f.mid, f.volume, f.premiumUsd, f.notionalUsd, f.baseline, f.multiple, f.structure]);
  }
  await q(`INSERT INTO options_oi (symbol, date, spot, oi, updated_at) VALUES ($1,$2,$3,$4, now()) ON CONFLICT (symbol) DO UPDATE SET date = excluded.date, spot = excluded.spot, oi = excluded.oi, updated_at = now()`, [day.symbol, day.date, spot, JSON.stringify(oi)]);
}

/** The stock's own normal: the median of its daily 95th-percentile OI increase over the last `days` captured days. */
export async function optionsBaseline(symbol: string, before: string, days = 20): Promise<{ median: number | null; n: number }> {
  const rows = (await q(`SELECT p95_up FROM options_oi_days WHERE symbol = $1 AND date < $2 AND p95_up IS NOT NULL ORDER BY date DESC LIMIT $3`, [symbol, before, days])).map((r) => Number(r.p95_up)).sort((a, b) => a - b);
  return { median: rows.length ? rows[Math.floor(rows.length / 2)] : null, n: rows.length };
}

export interface OptionsFlag { date: string; contract: string; symbol: string; type: "call" | "put"; strike: number; expiry: string; prevOi: number; oi: number; spot: number; mid: number | null; volume: number | null; premiumUsd: number | null; notionalUsd: number; baseline: number | null; multiple: number | null; structure: string | null }

export async function optionsFlagsSince(from: string): Promise<OptionsFlag[]> {
  return (await q(`SELECT * FROM options_flags WHERE date >= $1 ORDER BY date DESC, premium_usd DESC NULLS LAST`, [from])).map((r) => ({
    date: dstr(r.date)!, contract: r.contract, symbol: r.symbol, type: r.type, strike: Number(r.strike), expiry: dstr(r.expiry)!, prevOi: Number(r.prev_oi), oi: Number(r.oi), spot: Number(r.spot),
    mid: num(r.mid), volume: num(r.volume), premiumUsd: num(r.premium_usd), notionalUsd: Number(r.notional_usd), baseline: num(r.baseline), multiple: num(r.multiple), structure: r.structure ?? null,
  }));
}

export async function optionsLogStatus(): Promise<{ stocks: number; latest: string | null; days: number }> {
  const r = (await q(`SELECT count(*) AS stocks, max(date) AS latest FROM options_oi`))[0] ?? {};
  const d = (await q(`SELECT count(DISTINCT date) AS days FROM options_oi_days`))[0] ?? {};
  return { stocks: Number(r.stocks ?? 0), latest: dstr(r.latest), days: Number(d.days ?? 0) };
}

// ------------------------------------------------------------ chat

export interface ChatMessage { role: "user" | "assistant"; content: string; at: string }
export interface ChatThread { id: number; createdAt: string; briefing: string; messages: ChatMessage[] }

export async function createChatThread(briefing: string): Promise<number> {
  return Number((await q(`INSERT INTO chat_threads (briefing) VALUES ($1) RETURNING id`, [briefing]))[0].id);
}

export async function getChatThread(id: number): Promise<ChatThread | null> {
  const r = (await q(`SELECT id, created_at, briefing, messages FROM chat_threads WHERE id = $1`, [id]))[0];
  return r ? { id: Number(r.id), createdAt: iso(r.created_at)!, briefing: r.briefing, messages: (r.messages ?? []) as ChatMessage[] } : null;
}

export async function appendChat(id: number, msgs: ChatMessage[]): Promise<void> {
  await q(`UPDATE chat_threads SET messages = messages || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(msgs)]);
}

export async function recentChatThreads(limit = 15): Promise<Array<{ id: number; createdAt: string; first: string | null; turns: number }>> {
  return (await q(`SELECT id, created_at, messages->0->>'content' AS first, jsonb_array_length(messages) AS n FROM chat_threads ORDER BY updated_at DESC LIMIT $1`, [limit]))
    .map((r) => ({ id: Number(r.id), createdAt: iso(r.created_at)!, first: r.first ?? null, turns: Math.floor(Number(r.n ?? 0) / 2) }));
}

// ------------------------------------------------------------ Trump's posts

export interface StoredTruth { id: string; at: string; url: string; text: string; repost: boolean; read: import("./truth").TruthRead | null }

export async function truthSeen(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set((await q(`SELECT id FROM truth_posts WHERE id = ANY($1)`, [ids])).map((r) => String(r.id)));
}

export async function addTruthPost(p: { id: string; at: string; url: string; text: string; repost: boolean }, read: unknown): Promise<void> {
  await q(`INSERT INTO truth_posts (id, at, url, text, repost, read) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [p.id, p.at, p.url, p.text, p.repost, read ? JSON.stringify(read) : null]);
}

/** Posts since `fromIso`, newest first; with `relevantOnly`, only those the model judged market-relevant. */
export async function truthPostsSince(fromIso: string, relevantOnly = false): Promise<StoredTruth[]> {
  return (await q(`SELECT * FROM truth_posts WHERE at >= $1 ${relevantOnly ? "AND (read->>'relevant')::boolean" : ""} ORDER BY at DESC LIMIT 200`, [fromIso]))
    .map((r) => ({ id: String(r.id), at: iso(r.at)!, url: r.url, text: r.text, repost: !!r.repost, read: r.read ?? null }));
}


/** Watch-list upkeep when auto-approve is on: the scout's waiting proposals go live, and its terms with no card in 30 days are retired. Terms you added are never touched. */
export async function watchlistUpkeep(staleDays = 30): Promise<{ approved: number; retired: number }> {
  const approved = (await q(`UPDATE watchlist SET status = 'active' WHERE status = 'proposed' AND added_by = 'scout' RETURNING id`)).length;
  const retired = (await q(`UPDATE watchlist w SET status = 'retired' WHERE w.status = 'active' AND w.added_by = 'scout' AND w.added_at < now() - make_interval(days => $1)
    AND NOT EXISTS (SELECT 1 FROM candidates c WHERE lower(c.term) = lower(w.term) AND c.outcome = 'card' AND c.created_at > now() - make_interval(days => $1)) RETURNING id`, [staleDays])).length;
  return { approved, retired };
}

// ------------------------------------------------------------ ticker lookup

/** Cards on a stock, newest first: as the tracked ticker or anywhere in the card's ticker list. */
export async function cardsForSymbol(symbol: string, limit = 25): Promise<StoredCard[]> {
  return (await q(`SELECT ${CARD_COLS} FROM cards WHERE primary_ticker = $1 OR card->'tickers' @> jsonb_build_array(jsonb_build_object('symbol', $1::text)) ORDER BY created_at DESC LIMIT $2`, [symbol, limit])).map(toCard);
}
