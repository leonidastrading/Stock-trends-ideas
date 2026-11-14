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
  kind text NOT NULL,                -- invalidated | sent_to_swing | send_failed
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
