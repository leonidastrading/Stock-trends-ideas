/** Big, unmissable call on a card: bullish = buy, bearish = sell short. */
export const callLabel = (direction: "long" | "short") => (direction === "long" ? { mood: "Bullish", action: "Buy" } : { mood: "Bearish", action: "Sell short" });

export default function Direction({ direction, ticker, size = "big" }: { direction: "long" | "short"; ticker: string; size?: "big" | "small" }) {
  const { mood, action } = callLabel(direction);
  return (
    <span className={`call ${direction === "long" ? "bull" : "bear"} ${size}`}>
      {direction === "long" ? "▲" : "▼"} {mood} · {action} {ticker}
    </span>
  );
}
