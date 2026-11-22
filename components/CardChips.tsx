import type { CardBrief } from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

/** A stock's cards, newest first, as small links: direction, number and status. */
export default function CardChips({ cards, max = 4 }: { cards: CardBrief[]; max?: number }) {
  const xs = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      {xs.slice(0, max).map((c) => (
        <a key={c.id} className="tag card-number" style={{ marginRight: 4 }} href={`/cards/${c.id}`} title={`${c.direction} ${c.primaryTicker}, ${c.status.replace("_", " ")}, ${fmtEtAgo(c.createdAt)}`}>
          <span className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲" : "▼"}</span> #{c.id} <span className="muted">{c.status.replace("_", " ")}</span>
        </a>
      ))}
      {xs.length > max && <span className="small muted">+{xs.length - max} more</span>}
    </>
  );
}
