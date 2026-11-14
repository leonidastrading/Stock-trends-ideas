/** The card's call as colour and arrow only: green ▲ = long, red ▼ = short. */
export default function Direction({ direction, ticker, size = "big", name, warn = false }: { direction: "long" | "short"; ticker: string; size?: "big" | "small"; name?: string | null; warn?: boolean }) {
  const badge = (
    <span className={`call ${direction === "long" ? "bull" : "bear"} ${size}`} title={direction === "long" ? "long (buy)" : "short (sell short)"}>
      {direction === "long" ? "▲" : "▼"} {ticker}
    </span>
  );
  if (!name) return badge;
  return (
    <span className="call-with-name">
      {badge}
      <span className={`call-name ${warn ? "neg" : "secondary"}`} title="What this symbol trades as today (live listing)">{warn ? "⚠ " : ""}{name}</span>
    </span>
  );
}
