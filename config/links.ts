/** Vadim's TradingView chart layout; tickers across the app open it in a new tab with the symbol loaded. */
export const TRADINGVIEW_CHART = "https://www.tradingview.com/chart/WBvg0COi/";

export const chartUrl = (symbol: string) => `${TRADINGVIEW_CHART}?symbol=${encodeURIComponent(symbol.replace(/^\$/, "").toUpperCase())}`;
