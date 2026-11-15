import { chartUrl } from "@/config/links";

/** A ticker that opens its TradingView chart in a new tab. */
export default function Ticker({ symbol, className = "accent", children }: { symbol: string; className?: string; children?: React.ReactNode }) {
  return <a className={`ticker ${className}`} href={chartUrl(symbol)} target="_blank" rel="noreferrer" title={`Open ${symbol} on TradingView`}>{children ?? symbol}</a>;
}
