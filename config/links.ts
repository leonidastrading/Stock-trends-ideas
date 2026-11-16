/** Vadim's TradingView chart layout; tickers across the app open it in a new tab with the symbol loaded. */
export const TRADINGVIEW_CHART = "https://www.tradingview.com/chart/WBvg0COi/";

/** Alpaca's exchange names → TradingView's prefixes (a bare symbol can open a foreign stock: ARCC is also Arabian Cement). */
const TV_EXCHANGE: Record<string, string> = { NASDAQ: "NASDAQ", NYSE: "NYSE", ARCA: "AMEX", AMEX: "AMEX", BATS: "CBOE", OTC: "OTC" };

/** Pure: TradingView's symbol with its exchange when known ("NASDAQ:ARCC"), else the bare symbol. */
export const tvSymbol = (symbol: string, exchange?: string | null) => {
  const sym = symbol.replace(/^\$/, "").toUpperCase();
  const ex = exchange ? TV_EXCHANGE[exchange.toUpperCase()] : undefined;
  return ex ? `${ex}:${sym}` : sym;
};

/** Pure: the TradingView link for a US symbol, with its exchange when known ("NASDAQ:ARCC"). */
export const tradingViewUrl = (symbol: string, exchange?: string | null) => {
  const sym = symbol.replace(/^\$/, "").toUpperCase();
  const ex = exchange ? TV_EXCHANGE[exchange.toUpperCase()] : undefined;
  return `${TRADINGVIEW_CHART}?symbol=${encodeURIComponent(ex ? `${ex}:${sym}` : sym)}`;
};

/** Every ticker link goes through this app, which adds the exchange and forwards to TradingView. */
export const chartUrl = (symbol: string) => `/api/chart/${encodeURIComponent(symbol.replace(/^\$/, "").toUpperCase())}`;
