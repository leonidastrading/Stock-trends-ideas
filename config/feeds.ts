/** Every outside data source the scout reads, for Settings → Data sources. Description only; changing it changes nothing the scout does. */
export interface Feed { name: string; host: string; what: string; when: string; usedBy: string; key?: string }

export const FEEDS: Feed[] = [
  // The trend desk's probes (measured for every watch-list term)
  { name: "Google Trends", host: "trends.google.com", what: "12-month search interest for each term, and today's rising searches", when: "daily scan", usedBy: "Trend desk" },
  { name: "YouTube", host: "googleapis.com", what: "videos about a term uploaded this week vs the prior 4 weeks, and their views", when: "daily scan", usedBy: "Trend desk", key: "YOUTUBE_API_KEY" },
  { name: "Reddit", host: "reddit.com", what: "posts mentioning a term this week vs the month before", when: "daily scan", usedBy: "Trend desk" },
  { name: "Wikipedia", host: "wikimedia.org", what: "page views this week vs the 12-month average (also for people in stories)", when: "daily scan, research", usedBy: "Trend desk, story desk" },
  { name: "Apple App Store", host: "rss.marketingtools.apple.com", what: "US top free apps and rank changes", when: "daily scan", usedBy: "Trend desk" },
  { name: "Hacker News", host: "hn.algolia.com", what: "stories mentioning a term this week vs the 12-month weekly average", when: "daily scan", usedBy: "Trend desk" },
  { name: "Polymarket", host: "gamma-api.polymarket.com", what: "event odds and their one-week change; the Home odds panel", when: "daily scan, hourly panel", usedBy: "Trend desk, Home" },
  { name: "Stocktwits", host: "api.stocktwits.com", what: "trending stocks, message rates and bullish share; the chatter test; retail-mood gauge", when: "daily scan, hourly", usedBy: "Trend desk, chatter test, Home" },
  // News and market data
  { name: "Alpaca / Benzinga news", host: "data.alpaca.markets", what: "headlines with tickers: the News tab, the story desk, and how late an idea is", when: "every few minutes (News), hourly (story desk)", usedBy: "Story desk, News, Down drift, every card", key: "ALPACA_API_KEY_ID" },
  { name: "Alpaca market data", host: "data.alpaca.markets", what: "daily bars, quotes, top movers and option prices (read only; no orders, positions or account)", when: "after the close, and on demand", usedBy: "Paper tracking, Home panels, Down drift, cards", key: "ALPACA_API_KEY_ID" },
  { name: "Cboe delayed option chains", host: "cdn.cboe.com", what: "open interest and volume per contract: big new positions", when: "once per trading day per stock", usedBy: "Options positioning desk" },
  { name: "US Treasury", host: "home.treasury.gov", what: "daily Treasury yields", when: "hourly panel", usedBy: "Home" },
  { name: "Nasdaq earnings calendar", host: "api.nasdaq.com", what: "who reports in the next 5 days", when: "hourly panel", usedBy: "Home, cards" },
  { name: "USAspending", host: "api.usaspending.gov", what: "large new federal contracts", when: "hourly panel", usedBy: "Home" },
  // Filings and disclosures
  { name: "SEC EDGAR filings", host: "sec.gov", what: "Form 4 insider buys, new 13D stakes and serious 8-K items", when: "hourly", usedBy: "Insiders & filings desk", key: "SEC_USER_AGENT" },
  { name: "SEC company data", host: "data.sec.gov", what: "a company's recent filings, 8-K events and revenue growth for each card", when: "research", usedBy: "Every card", key: "SEC_USER_AGENT" },
  { name: "House disclosures", host: "disclosures-clerk.house.gov", what: "Representatives' stock trades (periodic transaction reports)", when: "hourly", usedBy: "Congress tab, insiders & Congress desk" },
  { name: "Senate disclosures", host: "efdsearch.senate.gov", what: "Senators' stock trades (electronic reports)", when: "hourly", usedBy: "Congress tab, insiders & Congress desk" },
  // People and your own inputs
  { name: "Trump's Truth Social posts", host: "trumpstruth.org", what: "every post (via the public archive's feed), read for market impact", when: "every 5 minutes, or hourly", usedBy: "Trump posts desk" },
  { name: "GitHub inbox", host: "api.github.com", what: "documents your bot drops in the inbox repo, read for ideas", when: "on each new file (webhook) or hourly", usedBy: "Your bot", key: "GITHUB_INBOX_REPO" },
  { name: "Nasdaq earnings calendar (actuals)", host: "api.nasdaq.com", what: "every report's consensus and actual EPS, timing, market cap and quarter end, plus sectors", when: "nightly after the close; the year of history loads hourly", usedBy: "Earnings drift (up)" },
  { name: "Finnhub earnings", host: "finnhub.io", what: "consensus and actual revenue per report", when: "nightly", usedBy: "Earnings drift (up)", key: "FINNHUB_API_KEY" },
  { name: "USAspending awards", host: "api.usaspending.gov", what: "federal contract awards by keyword or company, for investigations", when: "per investigation", usedBy: "Investigate" },
  { name: "Senate lobbying disclosures", host: "lda.senate.gov", what: "who paid lobbyists, on which issues, which agencies they lobbied", when: "per investigation", usedBy: "Investigate" },
  { name: "FEC campaign finance", host: "api.open.fec.gov", what: "PAC and campaign spending, including contributions to candidates", when: "per investigation", usedBy: "Investigate", key: "FEC_API_KEY" },
  { name: "Rumors", host: "(your files and sites)", what: "dumps from conspiracy forums and fringe sites (rumors/ folder, Rumors tab, or websites marked for rumors), filtered for market-relevant claims", when: "on each file, or daily per site", usedBy: "Rumors tab (checked only on request)" },
  { name: "BBC and Al Jazeera", host: "feeds.bbci.co.uk, aljazeera.com", what: "world and business headlines (wars, sanctions, elections, disasters)", when: "every 15-30 seconds while News is open, and in the story desk", usedBy: "News tab, breaking strip, story desk" },
  { name: "Press wires, SEC 8-Ks, Nasdaq halts", host: "globenewswire.com, prnewswire.com, sec.gov, nasdaqtrader.com", what: "company press releases, live 8-K filings and trading halts, faster than the Alpaca stream", when: "every 15 seconds while News is open, and every minute for phone alerts", usedBy: "News tab, breaking strip, story desk, phone alerts" },
  { name: "Google News search", host: "news.google.com", what: "headlines matching each rumor's key words (public RSS search), to see whether it came true", when: "daily, per rumor from the last 30 days", usedBy: "Rumors tab (came true / denied)" },
  { name: "Your websites", host: "(the list below)", what: "new articles on sites you add here, read for trade ideas", when: "once a day per site", usedBy: "Scout · your websites" },
];
