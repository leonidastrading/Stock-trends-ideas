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
- **The story desk** is one model call. Predicting the event is not the job; asking a better second question is, so
  for each story it first asks: what does this reveal (not just what happened), whose incentives just changed, and is
  the market's reaction smaller than the story's intensity? Then it lays out at most two trades: direct,
  second-order (a rival, a supplier, a platform losing traffic) or **reaction** (who has to respond to the public's or
  lawmakers' reaction, and which listed companies that hits, over weeks), with direction, horizon, thesis, why the
  market may still misprice it, and invalidation. It may skip a story and say why.
- **Reaction gaps.** The first-hours read often misses the trade: the UnitedHealth shooting did not change the business
  and the stock barely moved on day one; the move came over the following weeks from what the reaction revealed. Each
  midday scan looks again at stories seen 1–10 days ago (researched or skipped). A ticker is a gap when its news
  coverage is still loud (the latest two days average at least 4 stories a day and twice its pre-story pace) while it
  has moved less than 5% against SPY since the close before the story. Gaps go back to the desk as follow-ups and their
  trades are researched under `story: <key> (follow-up) → <ticker>`, once per story. The Stories page shows every
  check. Loudness is media coverage from the news stream; social-media anger needs Reddit (pending approval).
- **Stages.** The first headline is rarely the whole story (NVDA, Oct–Nov 2026: a spying report Nvidia denied, then
  the board's outside investigation, then the chip-diversion report and House committees, then the CEO's
  resignation). Every day the desk reads a story is recorded append-only in `story_events`. When a ticker with a
  story in the last 30 days gets headlines with an institution acting (a board investigation, outside counsel, a
  congressional committee or briefing, a regulator, prosecutors, a resignation), it is detected with only 2
  mainstream headlines, read at once despite the 3-day cooldown (once a day), labelled stage 2, 3…, and the desk sees
  the earlier stages and is asked who has to act next. Trades are logged as `story: <key> (stage N) → <ticker>`. A new
  stage restarts the reaction-gap clock, so the quiet test is measured from it, not from the first headline.
- **Building stories.** Attention that grows every day is a signal before any institution acts (the NVDA affair
  story dominated the news more each day before the resignation letter). A ticker's coverage is "building" when its
  stories per day rose three weekdays in a row, or the latest weekday is up and at least 1.5× the days before, with at
  least 4 that day (weekdays only, so a Monday after a quiet weekend is not a jump; today's partial count is
  ignored). A known story (last 30 days) that is building is read again at once despite the cooldown, once a day,
  logged as `story: <key> (building) → <ticker>`, and the desk is asked what the growing attention will force next.
  The reaction-gap check counts a building story as loud even before it reaches twice its old pace.
- **Public attention.** The desk names the company and up to three people at the centre of each story (stored with
  the story's day in `story_events`). The scout then reads their daily Wikipedia page views against the 30 days
  before the story was first seen, with the rising streak ("Jensen Huang: 90k views vs 9,000/day before, 10×, rising
  3 days in a row"), and puts it in front of the desk on stage, building and follow-up reads and on the Stories page.
  It is the free stand-in for social-media intensity until Reddit access is approved.
- **Follow or fade** (from the evidence-based news playbook: Chan 2003, Tetlock 2011, Lopez-Lira & Tang, Greenwood &
  Sammon). The desk classifies every story before choosing trades: **new or stale** (the code also measures staleness:
  how much today's headlines repeat the ticker's ten previous stories), **fundamental, flow or noise**, and **simple or
  complex**, and marks each trade **follow** or **fade**. New, fundamental news is followed, more so when it is bad,
  complex or about a small or opaque company; stale, flow-driven and no-news moves are faded. Horizons match the
  evidence: read-throughs about 5 trading days, bad-news drift weeks to months, flow trades out at the flow date,
  fades about a week. Transparent binary news (trial results, partnerships, earnings) is priced almost at once.
  Flows are treated with care: the S&P 500 addition effect has shrunk to about nothing and flow-driven moves tend to
  reverse once the flow is done. A "building" story is only re-read when its coverage is not mostly re-reported.
- The desk and the research step also ask whether the company is priced as one person's company, and name what else
  is moving the stock (an inflation print, an election, a sector sell-off, downgrades) so the result is not credited
  to the story alone.
- **Options pricing**, for the "how to trade it" note only: the median implied volatility of near-the-money calls
  20–60 days out (Alpaca option snapshots; free accounts get the indicative, 15-minute-delayed feed) against the
  stock's 20-day realized volatility. 1.5× or more reads as expensive (the story is already in the options' price),
  under 1.1× as cheap. Market data only, shown on Settings as "Options pricing"; never evidence, never tracked.
- **Each trade is researched as an event card** through the normal research step and gates, with the story and the
  proposed trade as context. Most story cards are logged **late**, since the story is everywhere by definition, and
  they are tracked on paper like any other. The Scoring page's "promoted versus late" table is where this style gets
  its verdict against SPY.
- A story's trades are researched once per 3 days. The desk runs inside the midday scan, from "Scan stories now" on
  Settings, and from `GET /api/cron/stories` (bearer `CRON_SECRET`), which is safe to call hourly (calls within 45 minutes
  of the last scan are answered "throttled" and do nothing; `?force=1` overrides): on the Hobby plan
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

0. **Ticker identity.** Symbols change hands (EchoStar moved from SATS to ECHO in June 2026 and SATS was reused for a
   Strive preferred stock, so card #16 tracked the wrong security). The model names each ticker's company; before the
   card is logged the code checks each symbol against what it trades as now (Alpaca asset metadata, read-only) and
   the SEC's ticker list. A symbol the SEC no longer lists for that company is corrected to the company's current one;
   a preferred, warrant, unit, right or note is dropped; a name that merely differs (Google / Alphabet) is kept with a
   note. If nothing valid is left the card is logged not promoted. Every change is a gate note. Already-open tracks
   whose symbol now trades as a preferred or note (or not at all) are excluded automatically by the after-close job,
   and a card's **Wrong security** button does the same by hand. Exclusion is an append-only `track_events` row with
   the reason; the card is never edited, it shows the reason, and it is left out of every score.
   Every card also shows, beside its ticker, the name the symbol **trades as today** (live listing, refreshed daily;
   red with ⚠ when it is not the named company's stock), and the **next earnings date**, estimated from the company's
   past earnings releases at the SEC (8-K item 2.02, usual quarterly gap), flagged when it falls before the card's exit.
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
- **Digest panels** (top of the Digest, full width; `components/MarketPanels.tsx`, `lib/market/`): breadth across the
  scout's 390-stock universe (advancing vs declining, new 52-week highs vs lows) and a 0–100 market mood from four parts
  (breadth, highs vs lows, S&P vs its 125-day average, VIX vs its 1-year average); market and rates vs the previous
  close (SPY, QQQ, IWM, USO from Alpaca as stand-ins for futures, which need a paid feed; 10- and 30-year yields from
  the Treasury's CSV; VIX from Cboe); earnings in the next 5 business days from Nasdaq's calendar, largest first (these
  dates also replace the scout's estimated next-earnings date on cards); the largest new federal contract obligations of
  the last 10 days from USAspending matched to listed parents (aliases for the big contractors, otherwise a strict
  SEC-name match; private firms such as Anduril or SpaceX are left out); and a buzz score out of 20 (chatter spike 0–8,
  news against its usual pace 0–6, Stocktwits trending 0–6). Each panel is cached in `dashboard_cache`, refreshed
  in housekeeping and on a page view when stale, and falls back to the last good copy. FDA and trial dates have no
  reliable free source and are not shown.
- **Congress** (`/congress`, `lib/sources/house.ts`, `lib/scout/congress.ts`): House members' STOCK Act periodic
  transaction reports, read from the House Clerk's official files (the yearly `{year}FD.zip` index, then each report's
  PDF text layer). Rows with an exchange ticker and asset type ST (stock) or OP (option) are kept, with owner (self,
  spouse, joint, child), buy / sell / partial sale, trade and notification dates and the reported amount range; bonds,
  T-bills, funds and private holdings have no ticker and are skipped, and scanned paper filings are recorded as
  unreadable. Reports and trades are append-only (`congress_filings`, `congress_trades`). Housekeeping reads new reports
  filed in the last 120 days (up to a minute per call), then prices every stock buy with Alpaca bars: return since the
  trade date and since the filing date, each against SPY. The page shows stocks bought by several members in the last 30
  days (a cluster: 3+ members buying, or 2 with $100k+ between them, with fewer sellers), the latest trades with links to
  the official PDFs, and per member: trades, typical reporting delay and how their buys did after the report was public.
  `?member=` and `?symbol=` filter it; the Digest shows the most-bought stocks. Senate reports and the President's OGE
  278-T are not read yet.
- **Options positioning** (Filings page `#options`, `lib/sources/cboe-options.ts`, `lib/scout/options-flow.ts`,
  `config/options.ts`): once each trading day between 10:00 and 16:00 ET (when the chains carry the previous close's
  open interest) housekeeping reads the free Cboe delayed option chain of ~110 heavily traded stocks and compares each
  contract's open interest with the last capture. A flag is a new out-of-the-money position (5%+ out, 5–450 days to
  expiry) of 2,000+ contracts, worth $2M+ of premium or $200M+ of stock, and 5× that stock's normal large day (the
  median of its daily 95th-percentile increase; until 5 days of history only 20,000+ contracts and $5M+ qualify).
  Two strikes on the same expiry that moved together are named as a vertical or ratio spread. Open interest never shows
  who opened a position or which side they took. Snapshots are overwritten (`options_oi`); day summaries and flags are
  append-only (`options_oi_days`, `options_flags`). The largest flags are pushed to the phone (three a day at most),
  shown on the Digest, and join the filings research desk (shared limit of three a day) with puts proposed short and
  calls long at low confidence; their cards score as their own Scoreboard player.
- **Chat** (`/chat`, `lib/scout/chat.ts`, `app/api/chat`): a chat window with the scout's model. A new chat first builds a
  briefing of everything the scout knows at that moment (market and breadth, earnings, cards from the last 45 days with
  their paper results against SPY, rejected ideas, stories, filings, options flags, Congress trades, contracts, buzz,
  inbox documents and the last 36 hours of headlines) and keeps it fixed for the thread, so later turns read it from
  the prompt cache. Replies stream; each turn is logged against the daily cap (purpose "chat"); threads are kept in
  `chat_threads` and reopen from "Earlier chats". "New chat" loads fresh data. Paper only.
- **I noticed something**: the text box from section 2B.
- **Candidates**: everything logged in the window, including rejections and why; the last scan's measurements per term;
  Google's rising queries for anything worth adding to the watch-list.
- **Watch-list**: term, kind, tickers, date, who added it; approve the scout's proposals, retire terms.
- **Scoring**: per version (see below), with a CSV export of every card and track.
- **Ideas tab** (`/ideas`, replaces Digest, Stories and Candidates, which redirect): market panels and dated
  catalysts, then every card in the window (7/30/90 days) with sort (best: promoted, late, not promoted by rank;
  newest; catalyst soonest), status and source filters (the Scoreboard players), a "From:" line per card, 10 a page;
  folded below: the activity log (everything considered, outcome filter), the story desk's last scan and reaction
  gaps, and the trend desk's last scan. `?card=N` opens the page holding card N.
- **News tab** (`/news`, `lib/scout/newsfeed.ts`): the last 24 hours of Alpaca news plus market-relevant Trump posts;
  "Top" ranks by freshness (half-life 6 hours), event words, pile-ups on one stock, a card on the stock and Trump
  posts, and pushes down many-ticker round-ups; "Latest" is newest first; polled every 30 seconds with new items marked.
- **Map tab** (`/map`, `lib/scout/idea-map.ts`): the scout's sources on a ring, every stock one of them flags in the
  middle with a line to each source; multi-source stocks sit nearer the centre and grow; rings show long/short cards;
  hover for why, click a source to isolate it. Built from stored data and panel caches only.
- **Home widgets**: fear & greed (the breadth mood) and retail greed (bullish share of tagged Stocktwits posts on the
  20 trending stocks) gauges; top gainers and losers (Alpaca's movers screener, read-only; falls back to the 390-stock
  universe); a Stocktwits table (trending, most active, most watched, most bullish, most bearish) with IT/CT tags for
  insider and Congress trades. X data needs a paid API, so Stocktwits stands in.
- **Tickers** link to the TradingView chart layout in `config/links.ts` (new tab).
- **Short gate**: shorts are not promoted under $5 or after a run-up of 50% in 30 days or 25% in 5 days (borrow cost,
  squeezes); short cards on cheap or spiking stocks show a warning.
- **Senate trades**: the Senate's disclosure search (efdsearch.senate.gov: accept the terms with the form's CSRF
  token, search periodic transaction reports, read each electronic report's table; paper filings are skipped) feeds
  the same `congress_filings` / `congress_trades` tables as the House, with chamber "Senate".
- **Insiders + Congress → research**: `smartMoneySignals` adds two research signals to the filings desk: a stock bought
  by both company insiders (non-routine, $25k+) and members of Congress within 45 days (strongest, 3.5), and Congress
  clusters (3+ members buying, or 2 with $100k+, fewer selling; 2–2.5), each only with something new in the last 5
  days. The desk now researches up to four a day; these cards (with filing and insider ones) score as "Scout ·
  insiders, filings & Congress".
- **Trump's posts** (`lib/sources/truth.ts`, `lib/scout/truth.ts`): truthsocial.com is behind a bot challenge, so the
  scout reads the trumpstruth.org archive's RSS feed. `/api/cron/truth` (cron secret; call every 5 minutes, e.g. from
  cron-job.org) and hourly housekeeping read new posts; a keyword net picks the ones that might touch markets and one
  low-effort model call judges them (tickers, sectors, direction, one-line summary, urgency 1–5). Posts are stored
  append-only (`truth_posts`). Urgency 4+ is pushed to the phone (6 a day at most); the most urgent with a clear stock
  and direction (2 a day) are researched as cards, scored as "Scout · Trump posts". Shown on the Digest and in the
  chat's briefing.
- **Polymarket panel**: the 100 busiest open markets, biggest odds moves (1 day, 7 days) first; cached 15 minutes;
  also in the chat's briefing. (The daily discovery scan already reads the same markets.)
- **Inbox summary** (top of the Inbox tab, `lib/scout/inbox-digest.ts`): after new documents are read, one model call
  (low effort, logged as "inbox_digest") summarises the last 3 days' documents into two separate lists, top ideas and
  news, each item with tickers, a one-or-two-sentence summary, source, date, importance 1–5 and a breaking flag; ideas
  link to the scout's card when it made one. Ranked breaking and important first, then recent (a "breaking" item older
  than a day no longer jumps the queue). Document text is now kept with each inbox file; older files are fetched again
  from GitHub. "Refresh summary" rewrites it on demand. Not part of the scored version.
- **Duplicates**: one card per stock and direction per player within 14 days (`lib/scout/dedupe.ts`); a repeat is logged
  as a rejected candidate ("duplicate: card #N …") before any model call, and checked again before the card is stored.
  Ideas in one document about the same stock and direction are merged before research. The story desk and the options
  desk are exempt (the story desk re-researches a story as it moves through stages).
- **Card prices**: each card header shows the current price and the move since the previous close (Alpaca snapshots,
  IEX feed, one batched call per page, cached a minute; no price rather than a slow page).
- **Inbox tab**: setup status, the prompt to give any bot (copy button), the file format (`lib/scout/inbox-spec.ts`:
  one JSON object `{ bot, generated_at, ideas: [...] }` per file, named `inbox/YYYY-MM-DD-<bot>.json`, ideas with
  term, observation, kind, tickers and optional company, direction, catalyst_date, horizon_days, invalidation,
  confirmed, sources), the direct-POST alternative, and the **track record**: every document received (GitHub file,
  pasted or posted), when, how it was read, how many ideas, and each idea's outcome with a link to its card.
- **GitHub inbox**: an outside bot can drop documents for the scout by committing them to a folder in a GitHub repo
  (`GITHUB_INBOX_REPO`, `GITHUB_INBOX_PATH` default `inbox`, `GITHUB_INBOX_TOKEN` with read-only Contents). On each
  hourly call (or "Check the GitHub inbox" on Settings) the scout reads every new file (until near the call's deadline; opening the Inbox tab or a GitHub webhook to `/api/inbox-hook` starts a read at once): `.json` / `.md` / `.txt`
  as text, `.pdf` via text extraction; a text file with the same name as a PDF is used instead of it. Ideas come from
  the daily file's machine-readable JSON block when present, otherwise the model pulls up to 12 concrete ideas out of
  the prose (only the document's own facts; the document is treated as data, not instructions). They are handed to
  `/api/cron/import`, researched in the background, logged as `inbox: <term>` and scored as "Your bot" on the
  Scoreboard. Each file version (path + git sha) is read once; a new commit of the same file is read again. The bot can
  also skip GitHub and POST `{ "text": "<the JSON array>", "label": "<name>" }` to `/api/cron/import` with
  `Authorization: Bearer $CRON_SECRET`.
- **Filings** (the playbook's best-documented signals): EDGAR's daily index is read the day after filing (www.sec.gov,
  declared User-Agent, under 8 requests a second) into a queue of Form 4, 8-K and Schedule 13D filings, worked through
  in time-limited slices on each hourly story call and after the close. Form 4 → open-market purchases (code P, not
  under a 10b5-1 plan) of at least $25k, flagged **opportunistic** when the insider did not trade in the same calendar
  month in each of the three previous years (Cohen, Malloy & Pomorski). 8-K → items 4.02 (non-reliance), 1.05 (cyber),
  4.01 (auditor), 2.06 (impairment), 2.05 (restructuring), 5.02 (departures). 13D → the subject company and the filer.
  Stored append-only (`insider_buys`, `filing_alerts`). At most one signal is researched per hourly call and three a
  day, strongest first: restatements and cyber incidents (bad news drifts), new 13Ds, then insider buying by two or
  more insiders or a large purchase against the insider's holding. Each is researched once per 30 days. The Filings
  page lists the queue, signals, purchases, 13Ds and 8-Ks.
- **Chatter test** (an experiment beside the scout; nothing in it becomes card evidence): does a spike in Stocktwits
  chatter while the price is still quiet predict the move? 198 stocks fixed in advance (the first 18 of each sector in
  the baseline universe). Each weekday every one is measured once from Stocktwits' public stream (messages per hour
  over the latest 30, bullish share of tagged messages) into the append-only `chatter_daily`, in fixed batches of 50
  that ride on the hourly story call (`/api/cron/stories`; `/api/cron/chatter` is a separate entry if needed) and the
  after-close job. A spike (log rate 2.5+ standard deviations above the stock's own previous 20–60 measurements, the
  first in 5 days) and about 1 in 40 ordinary stock-days (picked by a hash, as controls) are logged to the append-only
  `chatter_events` the day they are measured. Outcomes come from daily bars: entry at the next open, excess over SPY
  and the sector fund after 1, 5 and 20 sessions, and the average size of the move either way. Spikes are split by
  whether the 5 sessions before moved less than 3% against SPY (chatter leading, not following), by whether the stock
  had any story in the news stream that day or the day before (chatter with no news is the case news research expects
  to fade), and by bullish or bearish chatter, and every row is read against the controls. Needs about a month of warm-up and two to three months
  of events. The page also runs a **look-back** on Stocktwits' own 3-month message-volume history for the same stocks
  (`data/chatter-explore/`, fetched once through the Stocktwits connector; histories that stop early or were dark and
  then remapped are left out: AVB, EA, HES, IPG, PARA, WBD): exploratory only, since that score is scaled over the whole window (partly hindsight),
  smoothed, and has no sentiment.
- **Scoreboard**: the same results as a game, across all versions. Points are paper dollars beaten versus SPY on a
  $1,000 stake per call; players are the scout's trend desk, its story desk, you, and the stream file's host and agent.
  It shows banked and in-play points, the same points against each call's sector fund (was it the company or its
  industry?), hit rate with a coin-flip luck check, calibration (does a "70%" call win about
  70% of the time; Brier score), wins by kind of call, and recent rounds with their post-catalyst verdicts. Commentary
  only; the verdict stays on Scoring. A card's `confidence` is defined to the model as its probability of beating SPY
  over the holding period; calibration counts only versions that carry that definition.
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
- Present options trades as recommendations. Each card carries a "how to trade it" note on timing and structure (for
  a slow grind over weeks, options with at least twice that time to expiry, since short-dated ones can expire before the
  move), labelled as a note, never a recommendation or a size; all tracking is in shares.
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
app/                 pages (digest, stories, notice, candidates, watchlist, scoreboard, scoring, settings) and API routes
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
lib/scout/scoreboard.ts players, points, luck check, calibration — pure
lib/scout/followup.ts  reaction gaps: stories still loud while the stock is quiet
lib/scout/options.ts   implied vs realized volatility for the how-to-trade note
lib/scout/attention.ts coverage trend (building) and Wikipedia attention for a story's people
lib/scout/chatter.ts   the chatter test: measurement, spikes, controls, outcomes
lib/scout/staleness.ts how much today's headlines repeat a ticker's earlier stories
lib/sources/filings.ts EDGAR daily index, Form 4, 8-K and 13D header parsers
lib/scout/filings.ts   the filings desk: queue, signals, research
lib/scout/inbox.ts     the GitHub inbox: list, read, extract ideas, hand to the import
config/chatter.ts      the chatter test's fixed 198 stocks and rules
lib/scout/swing.ts   the post to the Swing ideas log
lib/schema.ts        idempotent SQL with append-only triggers
relay/               the EDGAR relay (deploy on Railway)
tests/               vitest
```
