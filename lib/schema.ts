/**
 * Database schema. Idempotent: applied on first use by lib/db.ts and by
 * `npm run db:migrate`. Cards, versions and track events are append-only,
 * enforced by triggers: they are never edited or deleted.
 */
export const SCHEMA_SQL = `-- Trend scout schema. Idempotent: safe to run repeatedly.

CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END $fn$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A version: model, effort, prompt, reply schema, gates, source list and watch-list rules.
CREATE TABLE IF NOT EXISTS scout_versions (
  id serial PRIMARY KEY,
  hash text NOT NULL UNIQUE,
  model text NOT NULL,
  effort text NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER scout_versions_ro BEFORE UPDATE OR DELETE ON scout_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER scout_versions_rot BEFORE TRUNCATE ON scout_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Watch-list: term, kind, linked tickers, who added it. Proposals wait for approval.
CREATE TABLE IF NOT EXISTS watchlist (
  id serial PRIMARY KEY,
  term text NOT NULL,
  kind text NOT NULL,
  tickers text[] NOT NULL DEFAULT '{}',
  added_by text NOT NULL,            -- seed | vadim | scout
  status text NOT NULL DEFAULT 'active',  -- active | proposed | retired
  note text,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_term_idx ON watchlist (lower(term));

-- One row per source per term per metric per day: the scout's own 12-month history.
CREATE TABLE IF NOT EXISTS signals (
  source text NOT NULL,
  term text NOT NULL,
  metric text NOT NULL,
  as_of date NOT NULL,
  value double precision,
  baseline double precision,         -- the comparable base the source itself supplied, if any
  change_vs_12m double precision,    -- value / base - 1
  detail jsonb,
  PRIMARY KEY (source, term, metric, as_of)
);
ALTER TABLE signals ADD COLUMN IF NOT EXISTS note text;
-- measured_on: ET date of the scan that measured it (a second scan that day reuses the row).
ALTER TABLE signals ADD COLUMN IF NOT EXISTS measured_on date;
CREATE INDEX IF NOT EXISTS signals_measured_idx ON signals (term, measured_on);

-- Source health, one row per source, overwritten on each check.
CREATE TABLE IF NOT EXISTS source_health (
  source text PRIMARY KEY,
  status text NOT NULL,              -- ok | down | missing | capped
  detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

-- Everything the scout considered, including what it rejected and why.
CREATE TABLE IF NOT EXISTS candidates (
  id bigserial PRIMARY KEY,
  version_id int NOT NULL REFERENCES scout_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL,              -- scout | human
  term text NOT NULL,
  kind_hint text,
  tickers_hint text[] NOT NULL DEFAULT '{}',
  observation text,                  -- the human's own words, when origin = human
  trigger jsonb,                     -- the accelerating signals that made it a candidate
  outcome text NOT NULL,             -- card | rejected | error
  reason text,
  card_id bigint
);

-- Thesis cards. Logged with the model, the version and the timestamp before anything else happens.
CREATE TABLE IF NOT EXISTS cards (
  id bigserial PRIMARY KEY,
  version_id int NOT NULL REFERENCES scout_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL,              -- scout | human
  kind text NOT NULL,
  title text NOT NULL,
  card jsonb NOT NULL,               -- the full card (section 4), lateness as recomputed by code
  model text NOT NULL,
  model_served text,
  prompt text NOT NULL,
  reply_text text NOT NULL,
  usage jsonb,
  cost_usd double precision,
  status text NOT NULL,              -- promoted | late | not_promoted
  gate_notes text[] NOT NULL DEFAULT '{}',
  primary_ticker text,
  sector text,
  direction text NOT NULL,
  time_limit_days int NOT NULL,
  catalyst_date date,
  rank_score double precision NOT NULL  -- novelty x materiality
);
CREATE INDEX IF NOT EXISTS cards_created_idx ON cards (created_at DESC);
CREATE OR REPLACE TRIGGER cards_ro BEFORE UPDATE OR DELETE ON cards FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER cards_rot BEFORE TRUNCATE ON cards FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Paper tracks: one per promoted or late card. Entry at the next open; exits by rule.
CREATE TABLE IF NOT EXISTS tracks (
  card_id bigint PRIMARY KEY REFERENCES cards(id),
  symbol text NOT NULL,
  sector_etf text NOT NULL,
  direction text NOT NULL,
  card_date date NOT NULL,           -- ET date of the card
  entry_date date,                   -- first session after the card
  entry_price double precision,
  spy_entry double precision,
  sector_entry double precision,
  deadline_date date NOT NULL,       -- earlier of catalyst + 1 day and the time limit
  exit_date date,
  exit_price double precision,
  spy_exit double precision,
  sector_exit double precision,
  exit_reason text,                  -- catalyst | time_limit | invalidated | delisted
  max_drawdown_pct double precision,
  tapped_at timestamptz,             -- when Vadim sent the card to the swing log
  swing_response jsonb
);

-- Append-only events on tracks (invalidation marked by hand, sends to the swing log).
CREATE TABLE IF NOT EXISTS track_events (
  id bigserial PRIMARY KEY,
  card_id bigint NOT NULL REFERENCES cards(id),
  kind text NOT NULL,                -- invalidated | sent_to_swing | send_failed | excluded (wrong security; left out of scoring)
  at timestamptz NOT NULL DEFAULT now(),
  detail text
);
CREATE OR REPLACE TRIGGER track_events_ro BEFORE UPDATE OR DELETE ON track_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Daily bars for tracked symbols, SPY, sector funds and the baseline universe.
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol text NOT NULL,
  date date NOT NULL,
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v bigint NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- Vadim's reactions to cards and stories: thumbs up or down with an optional note. Append-only; the latest per target counts.
CREATE TABLE IF NOT EXISTS feedback (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  target text NOT NULL,              -- 'card:<id>' | 'story:<key>'
  vote text NOT NULL CHECK (vote IN ('up', 'down')),
  note text
);
CREATE INDEX IF NOT EXISTS feedback_target_idx ON feedback (target, id DESC);
CREATE OR REPLACE TRIGGER feedback_ro BEFORE UPDATE OR DELETE ON feedback FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Post-catalyst reviews: one per card, written once. Commentary only; never changes a card or its track.
CREATE TABLE IF NOT EXISTS catalyst_reviews (
  card_id bigint PRIMARY KEY REFERENCES cards(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  verdict text NOT NULL,
  summary text NOT NULL,
  evidence jsonb,
  move_since_entry_pct double precision,
  model text
);
CREATE OR REPLACE TRIGGER catalyst_reviews_ro BEFORE UPDATE OR DELETE ON catalyst_reviews FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Story timeline: one row per story key per day the desk read it (stage 1, 2, ...). Append-only.
CREATE TABLE IF NOT EXISTS story_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  et_date date NOT NULL,
  key text NOT NULL,
  symbols text[] NOT NULL DEFAULT '{}',
  stage int NOT NULL,
  summary text NOT NULL,
  escalation text[] NOT NULL DEFAULT '{}',
  UNIQUE (key, et_date)
);
CREATE OR REPLACE TRIGGER story_events_ro BEFORE UPDATE OR DELETE ON story_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- The company and the people at the centre of the story, as the desk named them (for Wikipedia attention).
ALTER TABLE story_events ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE story_events ADD COLUMN IF NOT EXISTS people text[] NOT NULL DEFAULT '{}';
-- The desk's classification (new/stale, fundamental/flow/noise, simple/complex) and the measured staleness.
ALTER TABLE story_events ADD COLUMN IF NOT EXISTS labels jsonb;

-- Chatter test: one Stocktwits measurement per symbol per weekday, written once.
CREATE TABLE IF NOT EXISTS chatter_daily (
  date date NOT NULL,
  symbol text NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  per_hour double precision NOT NULL,
  sampled int NOT NULL,
  span_hours double precision NOT NULL,
  bullish_share double precision,
  watchers int,
  trending_rank int,
  PRIMARY KEY (date, symbol)
);
CREATE OR REPLACE TRIGGER chatter_daily_ro BEFORE UPDATE OR DELETE ON chatter_daily FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Chatter spikes and random controls, logged on the day they are measured (no hindsight). Outcomes are computed from bars.
CREATE TABLE IF NOT EXISTS chatter_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  date date NOT NULL,
  symbol text NOT NULL,
  kind text NOT NULL,
  z double precision,
  per_hour double precision NOT NULL,
  baseline_per_hour double precision,
  bullish_share double precision,
  UNIQUE (date, symbol, kind)
);
CREATE OR REPLACE TRIGGER chatter_events_ro BEFORE UPDATE OR DELETE ON chatter_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Earnings-release dates (8-K item 2.02) for the chatter test's stocks, so spikes around earnings are read apart.
CREATE TABLE IF NOT EXISTS earnings_dates (
  symbol text NOT NULL,
  date date NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- What each card's symbol trades as now, and its earnings dates (refreshed daily; a cache, not a record).
CREATE TABLE IF NOT EXISTS symbol_info (
  symbol text PRIMARY KEY,
  name text,
  exchange text,
  tradable boolean,
  last_earnings date,
  next_earnings date,
  next_basis text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

-- SEC filings: which daily indexes were read, and the queue of filings still to look at (processing state).
CREATE TABLE IF NOT EXISTS sec_index_days (
  date date PRIMARY KEY,
  entries int NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sec_queue (
  accession text PRIMARY KEY,
  form text NOT NULL,
  cik text NOT NULL,
  company text NOT NULL,
  filed date NOT NULL,
  path text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  note text,
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS sec_queue_status ON sec_queue (status, filed);

-- Insider open-market purchases (Form 4 code P), written once.
CREATE TABLE IF NOT EXISTS insider_buys (
  accession text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  filed date NOT NULL,
  issuer_cik text,
  symbol text,
  issuer_name text,
  owner text,
  owner_cik text,
  role text,
  tx_date date,
  shares double precision,
  price double precision,
  value double precision,
  owned_after double precision,
  pct_increase double precision,
  plan10b5 boolean,
  routine boolean
);
CREATE OR REPLACE TRIGGER insider_buys_ro BEFORE UPDATE OR DELETE ON insider_buys FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- New activist stakes (Schedule 13D) and 8-Ks with bad-news items, written once.
CREATE TABLE IF NOT EXISTS filing_alerts (
  accession text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  filed date NOT NULL,
  cik text,
  symbol text,
  company text,
  items text[] NOT NULL DEFAULT '{}',
  filer text
);
CREATE OR REPLACE TRIGGER filing_alerts_ro BEFORE UPDATE OR DELETE ON filing_alerts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- GitHub inbox: each file version (path + git sha) read once, with what came of it.
CREATE TABLE IF NOT EXISTS inbox_files (
  path text NOT NULL,
  sha text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  PRIMARY KEY (path, sha)
);
ALTER TABLE inbox_files ADD COLUMN IF NOT EXISTS text text;

-- Inbox summary: the top ideas and news of the documents received in the last few days, rewritten when new ones arrive.
CREATE TABLE IF NOT EXISTS inbox_digests (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  docs text[] NOT NULL,
  digest jsonb NOT NULL,
  cost_usd double precision
);

-- Congress trades (STOCK Act periodic transaction reports): each report read once, and its listed trades, never edited.
CREATE TABLE IF NOT EXISTS congress_filings (
  doc_id text PRIMARY KEY,
  chamber text NOT NULL,
  member text NOT NULL,
  state_dst text,
  filed date NOT NULL,
  year int NOT NULL,
  status text NOT NULL,
  trades int NOT NULL DEFAULT 0,
  read_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER congress_filings_ro BEFORE UPDATE OR DELETE ON congress_filings FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE IF NOT EXISTS congress_trades (
  doc_id text NOT NULL,
  ord int NOT NULL,
  chamber text NOT NULL,
  member text NOT NULL,
  state_dst text,
  filed date NOT NULL,
  owner text NOT NULL,
  symbol text NOT NULL,
  asset_type text NOT NULL,
  tx text NOT NULL,
  tx_date date NOT NULL,
  notified date,
  amount_low double precision,
  amount_high double precision,
  amount text NOT NULL,
  PRIMARY KEY (doc_id, ord)
);
CREATE INDEX IF NOT EXISTS congress_trades_filed_idx ON congress_trades (filed);
CREATE INDEX IF NOT EXISTS congress_trades_symbol_idx ON congress_trades (symbol);
CREATE OR REPLACE TRIGGER congress_trades_ro BEFORE UPDATE OR DELETE ON congress_trades FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Options positioning log: the latest open interest per contract for each stock (overwritten daily), each day's
-- summary (for every stock's own normal), and flags for unusual new positions (never edited).
CREATE TABLE IF NOT EXISTS options_oi (
  symbol text PRIMARY KEY,
  date date NOT NULL,
  spot double precision NOT NULL,
  oi jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS options_oi_days (
  symbol text NOT NULL,
  date date NOT NULL,
  prev_date date,
  contracts int NOT NULL,
  call_oi bigint NOT NULL,
  put_oi bigint NOT NULL,
  p95_up double precision,
  max_up double precision,
  PRIMARY KEY (symbol, date)
);
CREATE OR REPLACE TRIGGER options_oi_days_ro BEFORE UPDATE OR DELETE ON options_oi_days FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE IF NOT EXISTS options_flags (
  date date NOT NULL,
  contract text NOT NULL,
  symbol text NOT NULL,
  type text NOT NULL,
  strike double precision NOT NULL,
  expiry date NOT NULL,
  prev_oi int NOT NULL,
  oi int NOT NULL,
  spot double precision NOT NULL,
  mid double precision,
  volume int,
  premium_usd double precision,
  notional_usd double precision,
  baseline double precision,
  multiple double precision,
  structure text,
  PRIMARY KEY (date, contract)
);
CREATE INDEX IF NOT EXISTS options_flags_symbol_idx ON options_flags (symbol, date);
CREATE OR REPLACE TRIGGER options_flags_ro BEFORE UPDATE OR DELETE ON options_flags FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Chat tab: each conversation with its briefing (fixed for the thread so it stays cached) and messages.
CREATE TABLE IF NOT EXISTS chat_threads (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  briefing text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dashboard panels (market quotes, earnings calendar, contracts, breadth): cached fetches, refreshed hourly.
CREATE TABLE IF NOT EXISTS dashboard_cache (
  key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Phone pushes already sent, so each card, review or failure is pushed once.
CREATE TABLE IF NOT EXISTS notifications (
  key text PRIMARY KEY,
  title text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Headline counts per ticker per day from the news stream, for story spike detection.
CREATE TABLE IF NOT EXISTS ticker_news_daily (
  date date NOT NULL,
  symbol text NOT NULL,
  stories int NOT NULL,
  mainstream int NOT NULL,
  PRIMARY KEY (date, symbol)
);

-- Every model call, for the daily spend cap.
CREATE TABLE IF NOT EXISTS llm_calls (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  et_date date NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  usage jsonb,
  cost_usd double precision,
  ok boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_calls_date_idx ON llm_calls (et_date);

CREATE TABLE IF NOT EXISTS runs (
  id serial PRIMARY KEY,
  action text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL,
  detail jsonb,
  error text
);

CREATE TABLE IF NOT EXISTS emails_sent (
  key text PRIMARY KEY,
  subject text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  provider_id text
);
`;

/** Split into statements the Neon HTTP driver can run one at a time ($fn$ bodies kept whole). */
export function schemaStatements(): string[] {
  const out: string[] = [];
  let buf = "";
  let inFn = false;
  for (const line of SCHEMA_SQL.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    buf += line + "\n";
    const marks = (line.match(/\$fn\$/g) ?? []).length;
    if (marks === 1) inFn = !inFn;
    if (!inFn && t.endsWith(";")) {
      out.push(buf.trim());
      buf = "";
    }
  }
  return out;
}
