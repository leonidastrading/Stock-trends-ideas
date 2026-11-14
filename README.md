# Trend scout

A paper-only research assistant. It looks for **changes in the real world that the stock market has not priced yet**,
writes each one up as a thesis card, applies a few hard gates in code, and tracks every card on paper against SPY and
its sector fund. One tap sends a card to the existing **Swing ideas log** (the `spx-ai-agent` app) as a paper idea.

It suggests and records. **It never places, modifies or cancels an order at any broker**, and it has no code that could:
the only market-data client is read-only and allowlisted to bars, news and the trading calendar.

The question it answers after about six months: do the scout's ideas beat the market, do Vadim's own ideas beat the
market, and does the research add anything to an idea he noticed himself?

## How it works

Next.js (App Router, TypeScript) on Vercel with a Neon Postgres database, the same stack and conventions as the
Swing ideas app. Two Vercel cron jobs drive it:

| When (ET, weekdays) | Job | What happens |
|---|---|---|
| 12:30 | `GET /api/cron/daily` | **Scan.** Measure every active watch-list term on every source, store the measurements as the scout's own 12-month history, flag terms that accelerate, research the strongest few (one model call each) and log a card for each. On Mondays, email the weekly digest. |
| 17:30 | `GET /api/cron/track` | **Track.** Ingest daily bars (tracked stocks, SPY, the sector funds and the baseline universe), enter pending tracks at the next open, exit tracks whose rule is due, update drawdowns. |

Both check `Authorization: Bearer $CRON_SECRET`. Calling them more often is harmless (the scan is idempotent for a day's
measurements; cards are only written for new candidates; the tracker only moves forward).

### Two ways an idea starts

- **The scout finds it**, two ways, both in the daily scan:
  - **Discovery.** The scan reads what moved in the last 24 hours: every headline on the news stream (aggregated by
    ticker, with the headlines whose wording points at backlog, capacity, shortages, supply deals or raised guidance
    pulled out), Stocktwits' trending list with its "why it's trending" notes, the largest 7-day odds moves on
    Polymarket, Hacker News' front page and Google's rising queries. One model call proposes up to 3 candidates
    (term, kind, tickers, one sentence on what it saw), told to look one step behind the obvious names. Each proposal
    goes through the research step and gates like any other; a promoted or late one is also proposed for the
    watch-list so it keeps being measured.
  - **Watch-list acceleration.** A term is a candidate when at least **2 sources** are up **50% or more** against
    their 12-month base, one source has **tripled**, or (for event terms) a Polymarket market's odds moved
    **10+ points** in a week. Terms researched in the last 7 days are skipped; the top candidates (default 5 a day)
    go to the research step.
- **Vadim notices it.** The **"I noticed something"** page: one or two sentences, optionally a term, kind and tickers.
  The research step runs at once and returns the card in a minute or two. These cards are tagged **human-originated**
  and scored separately. A human card also lands on the watch-list as a proposal, so the scout keeps measuring it.

### Stories (event-driven trades)

A separate desk for discrete shocks: a CEO scandal or death, a war or ceasefire, a ban, tariff or sanction, a
regulator's move, an indictment, a recall, a pivot, a guidance cut. `lib/scout/stories.ts`:

- **Detection** is mechanical. The last 24 hours of the news stream are grouped by ticker; a ticker is a story when it
  has at least 3 mainstream headlines and either 2 headlines with shock wording, 12 or more headlines, or 4× its
  trailing daily average (kept in `ticker_news_daily`). Shock wording in headlines with no ticker makes a macro story
  (a war, a tariff) when at least 6 headlines carry it. Deal events (an IPO filing or pricing, a large funding round,
  an acquisition) count too, and because they are usually about a private company, an IPO, funding or deal story
  needs only 2 mainstream headlines; the desk is told to look for the listed companies that hold stakes, especially
  where the stake is large against the holder's market value (the Zoom / Anthropic kind of trade). Discovery sees
  the same deal headlines in their own section.
- **The story desk** is one model call that, for each story, lays out at most two trades: the direct one and the
  second-order one (a rival, a supplier, a platform losing traffic), with direction, horizon, thesis, why the market
  may still misprice it, and invalidation. It may skip a story and say why.
- **Each trade is researched as an event card** through the normal research step and gates, with the story and the
  proposed trade as context. Most story cards are logged **late**, since the story is everywhere by definition, and
  they are tracked on paper like any other. The Scoring page's "promoted versus late" table is where this style gets
  its verdict against SPY.
- A story's trades are researched once per 3 days. The desk runs inside the midday scan, from "Scan stories now" on
  Settings, and from `GET /api/cron/stories` (bearer `CRON_SECRET`), which is safe to call hourly: on the Hobby plan
  Vercel cron is daily only, so for intraday stories add a cron-job.org job every hour, 09:00–17:00 ET, with the
  header `Authorization: Bearer <CRON_SECRET>` (and `x-vercel-protection-bypass` if the deployment is protected).
- The **Stories** page shows the last detection, the desk's read and trades, and the story cards grouped by story,
  each with the Send and Invalidation buttons.

### Your reactions

Every card and every detected story has thumbs up / thumbs down and an optional note. Reactions are stored append-only
(the latest per target counts) and the discovery and story desks see the latest dozen of each, with the notes, when
they decide what to propose. They steer what gets proposed; they never change how a card is written or gated, so the
scoring stays honest. Settings lists them.

### Sources (version 1)

Each connector returns measurements with a source, metric, value, comparison base and as-of date. The Settings page
shows each source's health after every scan; a source that fails shows as **down** and the scout says so in the prompt
it sends and on the digest page. **missing** means no key or no data source.

| Source | What it measures | Needs |
|---|---|---|
| Google Trends | 12-month US search interest (0–100), last 4 weeks vs 12-month average; rising queries for watch-list proposals | nothing (unofficial endpoints, rate-limited; failures show as down) |
| YouTube Data API | videos on the term uploaded in 7 days vs the prior 4 weeks, plus their views | `YOUTUBE_API_KEY` |
| Reddit | posts mentioning the term across subreddits, 7 days vs the prior month; growth from a low base, not rank | `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` from an app Reddit has **approved** for Data API access (its policy requires a request first); off and marked missing until then |
| Wikipedia pageviews | the term's article: 7-day average views vs 12-month average | nothing |
| Apple App Store top charts | rank in the US top 100 free apps (12-month base from stored history); Google Play has no public feed and is marked missing | nothing |
| Hacker News | stories in 7 days vs the 12-month weekly average | nothing |
| SEC EDGAR | per linked ticker, from the free `data.sec.gov` JSON APIs: filings in 30 days vs the 12-month pace, material 8-K events in 90 days (1.01 agreements, 2.01 acquisitions, 2.03 new debt, 5.02 officer changes, with links), and quarterly revenue vs a year earlier. Full-text search across all filers only through the relay | `SEC_USER_AGENT` ("Name email", as the SEC requires). Requests stay under 8 a second. `efts.sec.gov` (full-text search) refuses cloud addresses, so it runs only through `relay/` on a machine you control, via `EDGAR_PROXY_URL` / `EDGAR_PROXY_TOKEN` |
| News stream (Alpaca/Benzinga) | stories tagged with the idea's tickers in 30 days, and how many came from mainstream outlets | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` |
| Polymarket | odds and weekly odds change for open markets matching the term | nothing |
| Stocktwits | per ticker: message rate per hour and bullish share from the public symbol stream; trending rank, score and watchers from the trending list (the same public endpoints as the Trending Five app) | nothing |

Sources that give no 12-month base of their own (Reddit, YouTube, app ranks, Stocktwits) get one from the scout's stored daily
measurements once 30 days exist. Every source is rate-limited per host, cached, and never scraped behind a login.
X and TikTok (paid) are left for a later version.

### The research step

For every candidate the model (default `claude-opus-5-5`, structured JSON output) writes one card in the format of
section 4 of the brief: title, kind, origin, observation, evidence, tickers (with revenue share and whether it is an
estimate, plus sector), why not priced, lateness, catalyst, direction, invalidation, time limit, scores, confidence,
unknowns. The only admissible evidence is the measurements the sources made; the model's own knowledge is used for
company exposure, revenue shares, the sector and the thesis.

Rules enforced by code (`lib/scout/card.ts`), in order:

1. **Evidence.** Every item needs a source and a date; items without are dropped. No evidence, no card — the candidate
   is logged as rejected.
2. **Materiality.** If the primary ticker's product or line is under **10%** of revenue, or the model could not estimate
   a share, the card is logged but **not promoted** and not tracked. Unsure shares are flagged as estimates.
3. **Lateness.** The code measures the primary ticker's 30- and 90-day move from daily bars and the mainstream stories
   in 30 days from the news stream, replacing the model's figures. Up more than **30%** in 30 days or more than **20**
   mainstream stories marks `already_obvious` and the card **late**: logged and tracked, never promoted.

The card is written with the model, the prompt, the version and the server timestamp **before** the track is created or
anything else happens. Cards, versions and track events are append-only, enforced by database triggers.

### What Vadim sees

- **Digest**: the top 3–5 promoted cards of the last 7 days ranked by novelty × materiality, lateness shown, the late
  cards below them. **Send to Swing ideas (paper)** posts the card to the Swing ideas app's `/api/swing` as a time-limit
  idea; that app places the paper order on its own paper account (queued for the open if the market is closed) and
  scores it in its own log. **Invalidation met** records that the thesis was disproved; the track exits at the next open.
- **I noticed something**: the text box from section 2B.
- **Candidates**: everything logged in the window, including rejections and why; the last scan's measurements per term;
  Google's rising queries for anything worth adding to the watch-list.
- **Watch-list**: term, kind, tickers, date, who added it; approve the scout's proposals, retire terms.
- **Scoring**: per version (see below), with a CSV export of every card and track.
- **Settings**: on/off, model and effort (changing either starts a new version), the daily LLM cap, candidates per
  scan, digest email; the source health panel; spend by day; versions and the frozen rules; which keys are set (values
  are never shown); recent runs.

### Scoring

Every promoted and late card is tracked on paper whether or not Vadim taps it. Entry is the open of the first session
after the card. Exit is the open of the first session at or after the earlier of: the day after the catalyst, the time
limit, or the day after the invalidation was marked. For each idea: return, SPY and the sector fund over the same days,
excess return, and the worst intraday drawdown while held. Open ideas are shown at the latest close and not counted.

Per version: **scout-originated**, **human-originated** and **human ideas Vadim tapped** (count, win rate against SPY,
average and median excess return, average excess against the sector, average drawdown); **by kind**; **promoted versus
late** (if late does as well as promoted, the lateness gate is not helping); **by score band** (novelty × materiality
≥ 49 vs below). **Baseline**: for each idea, 20 random stocks from the same sector (a fixed universe in
`config/universe.ts`, seeded by card id) over the same dates; 1,000 resamples give the distribution of the average, and
the page shows the percentile of the scout's average in it.

**Verdict** after 30 closed promoted ideas or six months, whichever is later: pass only if the average excess return over
SPY is positive and at or above the 90th percentile of the random-sector baseline.

Prices are split-adjusted daily bars from Alpaca's free IEX feed; dividends are ignored on both sides of every comparison.

### Versions and cost

A version is the sha256 of the model, effort, system prompt, reply schema, gates, source list, candidate rules and
baseline universe (`lib/scout/version.ts`). Changing any of them starts a new version; results are reported per version.
Don't tune the prompt on the version being scored.

Every model call is logged with its cost. When the day's spend reaches the cap (Settings, default $5) the scout stops for
the day and the candidates page says so. Each source has a per-host rate limit and a short cache.

## Do not

- Place, modify or cancel any order at any broker. (There is no such code; the Swing ideas app, which this app only posts
  to, trades on an Alpaca **paper** account.)
- Store or display API keys or tokens in the repo, logs or UI. Settings shows only whether each key is set.
- Present options trades as recommendations. A card may note a dated catalyst, nothing more; all tracking is in shares.
- Replay past dates through the model and call it evidence. Forward results only.
- Edit or delete logged cards, or tune the prompt on the version being scored.

## Setup

1. **Deploy** this repo on Vercel. Create a Neon database (Storage → Create → Neon) and connect it; that adds
   `DATABASE_URL`. Tables are created on first use (or run `npm run db:migrate`).
2. **Environment variables** (see `.env.example`): `DASHBOARD_USER` / `DASHBOARD_PASSWORD` (basic auth on every page
   and API), `CRON_SECRET` (Vercel sends it to the cron routes), `ANTHROPIC_API_KEY`, and Alpaca market-data keys
   (`ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`; read-only use). Optional: `SEC_USER_AGENT`, `YOUTUBE_API_KEY`, Reddit
   OAuth, Resend (`RESEND_API_KEY`, `ALERT_EMAIL`, `DASHBOARD_URL`).
3. **Swing ideas log**: `SWING_API_URL` (the spx-ai-agent deployment, no path), `SWING_API_USER` / `SWING_API_PASSWORD`
   (that app's dashboard login), `SWING_API_BYPASS` if its deployment is protected, `SWING_NOTIONAL` (default $5,000).
   Without these the Send button is disabled and says why. **Settings → Test the Swing login** reads that app's home
   page with these values and says which gate (its login, or Vercel's protection) refused.
4. `vercel.json` schedules the two cron jobs (17:30 and 22:30 UTC, Mon–Fri; midday so the EDGAR relay on a home computer is awake; the daily cadence works on the Hobby plan).
   The routes convert to America/New_York themselves, so DST only shifts them by an hour.
5. **Phone alerts** (optional, [ntfy](https://ntfy.sh)): set `NTFY_TOPIC` to a long random name, install the ntfy app and
   subscribe to that topic. You get a push for each new promoted scout card and story trade, for each post-catalyst
   verdict, and when a job fails. `NTFY_SERVER` / `NTFY_TOKEN` only for a self-hosted or protected server. Toggles on
   Settings; **Send a test to my phone** checks the wiring. Anyone who knows the topic name can read it, so keep it long.
6. **Post-catalyst check**: after the close, the tracker asks the model (effort low, inside the daily cap) whether each
   card whose catalyst date has passed (last 60 days) played out, from the price since entry and the news since the
   catalyst. The verdict is stored append-only beside the card; it is commentary and never changes the score.
7. Open **Watch-list** and review the seed terms; add your own. Open **Settings** and check the source health after the
   first scan.

## Local development

```bash
npm install
npm test                          # vitest: gates, scan rule, sources (fake HTTP), tracking, scoring, end to end on PGlite
npm run typecheck && npm run build
npm run dev                       # needs DATABASE_URL and the dashboard login in .env.local
npm run scan -- probe "data center power demand"   # measure one term on every source, no model call
npm run scan                      # run the daily job locally
npm run scan -- track             # run the tracker locally
```

## EDGAR relay

`relay/` holds a one-file Node service that forwards EDGAR full-text searches from a network the SEC accepts, because
`efts.sec.gov` returns 403 to Vercel's addresses whatever the User-Agent. Deploy it on Railway (root directory `relay`),
set `RELAY_TOKEN` and `SEC_USER_AGENT` there, and point the scout at it with `EDGAR_PROXY_URL` / `EDGAR_PROXY_TOKEN`.
Details in `relay/README.md`.

## Layout

```
app/                 pages (digest, notice, candidates, watchlist, scoring, settings) and API routes
components/          CardView (the thesis card), CardActions (send / invalidation), SetupNotice
config/scout.ts      frozen rules: gates, candidate rule, caps, sectors → funds, seed watch-list, model prices
config/universe.ts   stocks per sector for the random baseline
lib/alpaca.ts        read-only, allowlisted market-data client (daily bars, news, calendar)
lib/sources/         one connector per source + registry
lib/scout/card.ts    card schema (zod + JSON schema) and the gates — pure
lib/scout/prompt.ts  the research prompt — part of the version hash
lib/scout/research.ts  one candidate → card → gates → log → track
lib/scout/scan.ts    the daily scan and the candidate rule
lib/scout/tracking.ts  paper entries, exits and drawdowns
lib/scout/scoring.ts   the report and the random-sector baseline — pure
lib/scout/swing.ts   the post to the Swing ideas log
lib/schema.ts        idempotent SQL with append-only triggers
relay/               the EDGAR relay (deploy on Railway)
tests/               vitest
```
