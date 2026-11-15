import { chartUrl } from "@/config/links";

/** The card's call as colour and arrow only: green ▲ = long, red ▼ = short. */
export default function Direction({ direction, ticker, size = "big", name, warn = false }: { direction: "long" | "short"; ticker: string; size?: "big" | "small"; name?: string | null; warn?: boolean }) {
  const badge = (
    <a className={`call ${direction === "long" ? "bull" : "bear"} ${size}`} href={chartUrl(ticker)} target="_blank" rel="noreferrer" title={`${direction === "long" ? "long (buy)" : "short (sell short)"} · open ${ticker} on TradingView`}>
      {direction === "long" ? "▲" : "▼"} {ticker}
    </a>
  );
  if (!name) return badge;
  return (
    <span className="call-with-name">
      {badge}
      <span className={`call-name ${warn ? "neg" : "secondary"}`} title="What this symbol trades as today (live listing)">{warn ? "⚠ " : ""}{name}</span>
    </span>
  );
}
