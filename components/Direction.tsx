/** The card's call as colour and arrow only: green ▲ = long, red ▼ = short. */
export default function Direction({ direction, ticker, size = "big" }: { direction: "long" | "short"; ticker: string; size?: "big" | "small" }) {
  return (
    <span className={`call ${direction === "long" ? "bull" : "bear"} ${size}`} title={direction === "long" ? "long (buy)" : "short (sell short)"}>
      {direction === "long" ? "▲" : "▼"} {ticker}
    </span>
  );
}
