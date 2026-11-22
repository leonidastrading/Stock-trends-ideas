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
  deadline_date date NOT NULL,       -- the time limit (cards before exit rule "time_limit": earlier of catalyst + 1 day and the time limit)
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
  kind text NOT NULL,                -- invalidated | sent_to_swing | send_failed | excluded (wrong security; left out of scoring) | tracked_from_listing | listing_not_followed
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
ALTER TABLE insider_buys ADD COLUMN IF NOT EXISTS owner_state text;
ALTER TABLE insider_buys ADD COLUMN IF NOT EXISTS issuer_state text;
ALTER TABLE insider_buys ADD COLUMN IF NOT EXISTS local boolean;
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

-- Filing watch for card stocks: a row each time a stock's status changes (late 10-Q/10-K, late-filing notice, 4.01/4.02).
CREATE TABLE IF NOT EXISTS filing_watch (
  id serial PRIMARY KEY,
  symbol text NOT NULL,
  cik text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  key text NOT NULL,
  message text,
  data jsonb
);
CREATE INDEX IF NOT EXISTS filing_watch_symbol_idx ON filing_watch (symbol, checked_at);
-- Dots: second-order ideas from changes in behaviour in the news, one row per run (never edited).
CREATE TABLE IF NOT EXISTS dots_runs (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  et_date date NOT NULL,
  ideas jsonb NOT NULL,
  headlines integer,
  cost_usd double precision
);
ALTER TABLE dots_runs ADD COLUMN IF NOT EXISTS changes jsonb;
ALTER TABLE dots_runs ADD COLUMN IF NOT EXISTS sources jsonb;
CREATE OR REPLACE TRIGGER dots_runs_ro BEFORE UPDATE OR DELETE ON dots_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Cards you starred (your own list; starring changes nothing about the card or its scoring).
CREATE TABLE IF NOT EXISTS favorites (
  card_id integer PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now()
);
-- One-sentence thesis per card (display only; never part of the card or its scoring).
CREATE TABLE IF NOT EXISTS card_theses (
  card_id integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  thesis text NOT NULL
);
CREATE OR REPLACE TRIGGER card_theses_ro BEFORE UPDATE OR DELETE ON card_theses FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER filing_watch_ro BEFORE UPDATE OR DELETE ON filing_watch FOR EACH ROW EXECUTE FUNCTION forbid_change();

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
ALTER TABLE congress_trades ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
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

-- Trump's Truth Social posts (from the trumpstruth.org archive), each with the model's market read; never edited.
CREATE TABLE IF NOT EXISTS truth_posts (
  id text PRIMARY KEY,
  at timestamptz NOT NULL,
  url text NOT NULL,
  text text NOT NULL,
  repost boolean NOT NULL DEFAULT false,
  read jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS truth_posts_at_idx ON truth_posts (at);
CREATE OR REPLACE TRIGGER truth_posts_ro BEFORE UPDATE OR DELETE ON truth_posts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Websites Vadim asked the scout to read every day (Settings → Your websites); new articles are read for trade ideas.
CREATE TABLE IF NOT EXISTS sites (
  id serial PRIMARY KEY,
  url text NOT NULL UNIQUE,
  label text NOT NULL,
  feed_url text,
  via text,
  active boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  status text,
  detail text
);
-- Every article seen on those sites. baseline = already there when the site was added (not researched).
CREATE TABLE IF NOT EXISTS site_articles (
  url text PRIMARY KEY,
  site_id integer NOT NULL,
  title text NOT NULL,
  published timestamptz,
  seen_at timestamptz NOT NULL DEFAULT now(),
  baseline boolean NOT NULL DEFAULT false,
  outcome text
);
CREATE INDEX IF NOT EXISTS site_articles_site_idx ON site_articles (site_id, seen_at);

-- Rumors: documents dropped in (rumors/ folder, pasted, uploaded, or a website marked for rumors), and the
-- market-relevant claims the model found in them, each checked against the week's mainstream headlines.
CREATE TABLE IF NOT EXISTS rumor_docs (
  id serial PRIMARY KEY,
  source text NOT NULL,
  path text UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  chars integer NOT NULL DEFAULT 0,
  rumors integer NOT NULL DEFAULT 0,
  cost_usd double precision,
  error text
);
CREATE TABLE IF NOT EXISTS rumors (
  id serial PRIMARY KEY,
  doc_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claim text NOT NULL,
  tickers text[] NOT NULL DEFAULT '{}',
  direction text NOT NULL DEFAULT 'none',
  category text NOT NULL DEFAULT 'other',
  specificity integer NOT NULL DEFAULT 2,
  timeframe text,
  confirm text,
  source text,
  quote text,
  mainstream jsonb
);
CREATE INDEX IF NOT EXISTS rumors_created_idx ON rumors (created_at);
-- Themes: once a day, the top 3 ideas most sources talk about and agree on (with prices at the time), never edited.
CREATE TABLE IF NOT EXISTS theme_runs (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  et_date date NOT NULL,
  themes jsonb NOT NULL,
  sources jsonb,
  cost_usd double precision
);
CREATE OR REPLACE TRIGGER theme_runs_ro BEFORE UPDATE OR DELETE ON theme_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Themes sent to the Swing ideas log (main ticker), once each, never edited.
CREATE TABLE IF NOT EXISTS theme_sends (
  run_id integer NOT NULL,
  idx integer NOT NULL,
  ticker text NOT NULL,
  side text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  response jsonb,
  PRIMARY KEY (run_id, idx)
);
CREATE OR REPLACE TRIGGER theme_sends_ro BEFORE UPDATE OR DELETE ON theme_sends FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Watching open cards for their invalidation: one row per check (never edited); the latest is the card's state.
CREATE TABLE IF NOT EXISTS invalidation_checks (
  id serial PRIMARY KEY,
  card_id integer NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  verdict text NOT NULL,
  condition text,
  reason text
);
CREATE INDEX IF NOT EXISTS invalidation_checks_card_idx ON invalidation_checks (card_id, checked_at);
-- "Still valid?" re-checks asked from a card: one row per answer (never edited); the card itself is never changed.
CREATE TABLE IF NOT EXISTS card_rechecks (
  id serial PRIMARY KEY,
  card_id integer NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  verdict text NOT NULL,
  summary text,
  changed jsonb,
  catalyst_status text,
  watch_next text,
  paper_view text,
  price_then numeric,
  price_now numeric,
  cost_usd numeric
);
CREATE INDEX IF NOT EXISTS card_rechecks_card_idx ON card_rechecks (card_id, checked_at);
CREATE OR REPLACE TRIGGER card_rechecks_ro BEFORE UPDATE OR DELETE ON card_rechecks FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Research you asked for (every "Research it" button and the Research tab): one row per request, finished in place.
CREATE TABLE IF NOT EXISTS research_requests (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  term text NOT NULL,
  tickers text[] NOT NULL DEFAULT '{}',
  from_label text,
  from_url text,
  status text NOT NULL DEFAULT 'running',
  card_id integer,
  card_status text,
  reason text
);
CREATE INDEX IF NOT EXISTS research_requests_finished_idx ON research_requests (finished_at);
-- Bubbles: fixed-date events with a run-up into them ("buy the rumor, sell the news"), and what the stock did after.
CREATE TABLE IF NOT EXISTS bubble_events (
  id serial PRIMARY KEY,
  symbol text NOT NULL,
  event_type text NOT NULL,
  event_date date NOT NULL,
  what text,
  url text,
  source text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_measured timestamptz,
  price_seen numeric,
  run30 numeric,
  spy30 numeric,
  stage integer,
  score integer,
  per_hour numeric,
  z numeric,
  level text,
  level_seen text,
  price_event numeric,
  price_after5 numeric,
  price_after10 numeric,
  spy_event numeric,
  spy_after10 numeric,
  UNIQUE (symbol, event_type, event_date)
);
-- Market cap and short interest per card, frozen once, for splitting results by size and by short interest.
CREATE TABLE IF NOT EXISTS card_profiles (
  card_id integer PRIMARY KEY,
  symbol text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  market_cap double precision,
  cap_bucket text,
  short_pct_float double precision,
  short_pct_out double precision,
  days_to_cover double precision,
  squeeze text,
  short_as_of text,
  late boolean NOT NULL DEFAULT false
);
CREATE OR REPLACE TRIGGER card_profiles_ro BEFORE UPDATE OR DELETE ON card_profiles FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE card_profiles ADD COLUMN IF NOT EXISTS positioning jsonb;
-- Did the rumor come true? One row per daily check (never edited); the latest is its status.
CREATE TABLE IF NOT EXISTS rumor_checks (
  id serial PRIMARY KEY,
  rumor_id integer NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text
);
CREATE INDEX IF NOT EXISTS rumor_checks_rumor_idx ON rumor_checks (rumor_id, checked_at);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'ideas';

-- Investigations: "follow the money" behind a story (plan, public records pulled, report).
CREATE TABLE IF NOT EXISTS investigations (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'running',
  title text,
  input text NOT NULL,
  plan jsonb,
  records jsonb,
  report jsonb,
  cost_usd double precision,
  error text
);

-- Earnings drift (up): the trailing year of EPS surprises (for ranks), every report scanned (setup or reason),
-- the paper track of each setup, and the AI's card for each A-setup (never edited).
CREATE TABLE IF NOT EXISTS earnings_history (
  symbol text NOT NULL,
  report_date date NOT NULL,
  surprise double precision NOT NULL,
  cap_group text NOT NULL,
  PRIMARY KEY (symbol, report_date)
);
CREATE INDEX IF NOT EXISTS earnings_history_group_idx ON earnings_history (cap_group, report_date);
ALTER TABLE earnings_history ADD COLUMN IF NOT EXISTS eps_actual double precision;
ALTER TABLE earnings_history ADD COLUMN IF NOT EXISTS eps_estimate double precision;
ALTER TABLE earnings_history ADD COLUMN IF NOT EXISTS runup_10d double precision;
ALTER TABLE earnings_history ADD COLUMN IF NOT EXISTS source text;
-- Consensus frozen before each report (latest capture before the release), with market cap and year-ago EPS as of then.
CREATE TABLE IF NOT EXISTS earnings_consensus (
  symbol text NOT NULL,
  report_date date NOT NULL,
  timing text NOT NULL,
  eps_estimate double precision,
  revenue_estimate double precision,
  market_cap double precision,
  quarter_end date,
  last_year_eps double precision,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, report_date)
);
-- What the AI read for each A-setup (press release, headlines before paper entry) and the code's own guidance read.
CREATE TABLE IF NOT EXISTS earnings_docs (
  scan_id integer PRIMARY KEY,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  press_url text,
  press_text text,
  headlines jsonb,
  guidance_numeric text
);
CREATE TABLE IF NOT EXISTS earnings_scans (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  version text NOT NULL,
  symbol text NOT NULL,
  report_date date NOT NULL,
  reaction_date date NOT NULL,
  timing text NOT NULL,
  setup text,
  reason text,
  numbers jsonb NOT NULL,
  UNIQUE (symbol, report_date)
);
CREATE OR REPLACE TRIGGER earnings_scans_ro BEFORE UPDATE OR DELETE ON earnings_scans FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE IF NOT EXISTS earnings_tracks (
  scan_id integer PRIMARY KEY,
  entry_date date NOT NULL,
  exit_date date,
  next_report date,
  next_known boolean NOT NULL DEFAULT false,
  entry_price double precision,
  exit_price double precision,
  closed boolean NOT NULL DEFAULT false,
  ret_pct double precision,
  spy_pct double precision,
  peer_pct double precision,
  worst_pct double precision,
  tapped_at timestamptz,
  swing_body jsonb
);
ALTER TABLE earnings_tracks ADD COLUMN IF NOT EXISTS close_price double precision;
ALTER TABLE earnings_tracks ADD COLUMN IF NOT EXISTS ret_close_pct double precision;
ALTER TABLE earnings_tracks ADD COLUMN IF NOT EXISTS spy_close_pct double precision;
ALTER TABLE earnings_tracks ADD COLUMN IF NOT EXISTS exit_basis text;
ALTER TABLE earnings_tracks ADD COLUMN IF NOT EXISTS exit_moves jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Where an idea sent to research came from (the page and a link back to it), e.g. "Dots", "/dots?run=12#dot-121".
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS source_label text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS source_url text;
-- Anything the daily AI budget turned away, worked through after the midnight reset (nothing is skipped).
CREATE TABLE IF NOT EXISTS catchup_queue (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  done_at timestamptz,
  result text
);
CREATE INDEX IF NOT EXISTS catchup_queue_status_idx ON catchup_queue (status, id);
-- The scout's copy of Reddit (finance subreddits and the rumor subreddits), read through Arctic Shift; 60 days kept.
CREATE TABLE IF NOT EXISTS reddit_posts (
  id text PRIMARY KEY,
  sub text NOT NULL,
  created_at timestamptz NOT NULL,
  title text NOT NULL,
  body text,
  score integer,
  comments integer,
  url text
);
CREATE INDEX IF NOT EXISTS reddit_posts_sub_time_idx ON reddit_posts (sub, created_at);
CREATE TABLE IF NOT EXISTS earnings_cards (
  scan_id integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  model text NOT NULL,
  version text NOT NULL,
  card jsonb NOT NULL,
  cost_usd double precision
);
CREATE OR REPLACE TRIGGER earnings_cards_ro BEFORE UPDATE OR DELETE ON earnings_cards FOR EACH ROW EXECUTE FUNCTION forbid_change();

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

-- The filing-change reader: each 10-K / 10-Q compared with the same form a year earlier (one row per filing).
CREATE TABLE IF NOT EXISTS filing_diffs (
  accession text PRIMARY KEY,
  cik text NOT NULL,
  ticker text,
  company text,
  form text NOT NULL,
  filed date NOT NULL,
  url text,
  prior_accession text,
  prior_filed date,
  prior_url text,
  similarity double precision,
  added integer,
  removed integer,
  mechanical jsonb,
  ai jsonb,
  flag text NOT NULL,
  source text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS filing_diffs_ticker_idx ON filing_diffs (ticker, filed DESC);

-- Stocktwits attention for stocks on cards, once a weekday (the crowding score's baseline builds from these).
CREATE TABLE IF NOT EXISTS card_attention (
  date date NOT NULL,
  symbol text NOT NULL,
  per_hour double precision NOT NULL,
  bullish_share double precision,
  watchers integer,
  sampled integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, symbol)
);

-- Crowding score and stage per card: one row at entry (when the card is written) and one per weekday while open. Append-only.
CREATE TABLE IF NOT EXISTS card_crowding (
  id serial PRIMARY KEY,
  card_id integer NOT NULL,
  symbol text NOT NULL,
  kind text NOT NULL,
  measured_on date NOT NULL,
  score integer,
  stage integer,
  parts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS card_crowding_once ON card_crowding (card_id, kind, measured_on);
CREATE OR REPLACE TRIGGER card_crowding_ro BEFORE UPDATE OR DELETE ON card_crowding FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Analyst coverage (Finnhub recommendation counts), refreshed weekly per symbol.
CREATE TABLE IF NOT EXISTS analyst_coverage (
  symbol text PRIMARY KEY,
  analysts integer,
  period text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Supply-chain read-through: who supplies whom (from filings, web search and the model), and each capex-raise event.
CREATE TABLE IF NOT EXISTS supply_links (
  customer text NOT NULL,
  supplier text NOT NULL,
  name text,
  evidence text,
  url text,
  confidence integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer, supplier)
);
CREATE TABLE IF NOT EXISTS readthrough_events (
  id serial PRIMARY KEY,
  customer text NOT NULL,
  et_date date NOT NULL,
  headline text NOT NULL,
  url text,
  suppliers jsonb,
  researched jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer, et_date)
);

-- What the scout kept from your websites' articles and reports (stocks, summary, claims), for research, Dots, chat and cards.
CREATE TABLE IF NOT EXISTS site_digests (
  url text PRIMARY KEY,
  site_id integer,
  title text,
  published timestamptz,
  tickers text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL,
  claims jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_digests_tickers_idx ON site_digests USING gin (tickers);

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
