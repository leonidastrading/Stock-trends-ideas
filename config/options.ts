/**
 * Stocks whose option chains the positioning log reads every trading day: the most heavily traded US
 * single-stock option markets plus the scout's frequent story names. Index ETFs are left out: their big
 * put positions are almost always portfolio hedges.
 */
export const OPTIONS_UNIVERSE = [
  "NVDA", "TSLA", "AAPL", "AMZN", "MSFT", "META", "GOOGL", "AMD", "AVGO", "NFLX", "PLTR", "MSTR", "COIN", "HOOD", "SMCI", "MU",
  "INTC", "ARM", "TSM", "ASML", "QCOM", "TXN", "AMAT", "LRCX", "MRVL", "ON", "ANET", "DELL", "HPE", "IBM", "CSCO", "ORCL",
  "CRM", "ADBE", "NOW", "SNOW", "CRWD", "PANW", "SHOP", "UBER", "ABNB", "APP", "RBLX", "SNAP", "PINS", "DKNG", "AFRM", "UPST",
  "SOFI", "PYPL", "XYZ", "MARA", "RIOT", "JPM", "BAC", "C", "WFC", "GS", "MS", "SCHW", "BA", "LMT", "RTX", "GE",
  "CAT", "DE", "F", "GM", "RIVN", "LCID", "NIO", "BABA", "PDD", "JD", "XOM", "CVX", "OXY", "SLB", "UNH", "LLY",
  "PFE", "MRK", "JNJ", "ABBV", "MRNA", "BMY", "AMGN", "CVS", "WMT", "COST", "TGT", "HD", "NKE", "SBUX", "MCD", "DIS",
  "T", "VZ", "KO", "CCL", "AAL", "DAL", "UAL", "LULU", "NBIS", "CRWV", "ASTS", "RKLB", "IONQ", "OKLO", "SMR", "TEM",
] as const;
