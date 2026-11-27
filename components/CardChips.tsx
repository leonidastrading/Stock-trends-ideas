import type { CardBrief } from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

/**
 * Pure: a stock's cards split into the ones written about it (it is the stock the card tracks) and the ones that only
 * name it as a related stock, each newest first. A card about Lockheed that lists RTX as a related name is not an
 * RTX call, and its arrow is Lockheed's direction, not RTX's.
 */
export function splitBySymbol(cards: CardBrief[], symbol: string | null | undefined): { direct: CardBrief[]; related: CardBrief[] } {
  const xs = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!symbol) return { direct: xs, related: [] };
  const s = symbol.toUpperCase();
  return { direct: xs.filter((c) => c.primaryTicker === s), related: xs.filter((c) => c.primaryTicker !== s) };
}

/** One card as a small link. `related`: the card is about another stock and only names this one. */
export function CardChip({ c, related = false, label }: { c: CardBrief; related?: boolean; label?: React.ReactNode }) {
  const arrow = <span className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲" : "▼"}</span>;
  return related ? (
    <a className="tag card-number related" style={{ marginRight: 4 }} href={`/cards/${c.id}`} title={`Card #${c.id} is about ${c.primaryTicker} (${c.direction}), ${c.status.replace("_", " ")}, ${fmtEtAgo(c.createdAt)}. It only names this stock as a related one: it is not a call on it.`}>
      #{c.id} <span className="muted">in a {c.primaryTicker} card</span>{label ? <> <span className="muted">{label}</span></> : null}
    </a>
  ) : (
    <a className="tag card-number" style={{ marginRight: 4 }} href={`/cards/${c.id}`} title={`Card #${c.id}: ${c.direction} ${c.primaryTicker}, ${c.status.replace("_", " ")}, ${fmtEtAgo(c.createdAt)}`}>
      {arrow} #{c.id} <span className="muted">{label ?? c.status.replace("_", " ")}</span>
    </a>
  );
}

/**
 * A stock's cards as small links. With `symbol`, the cards written about that stock come first (arrow, number,
 * status) and the cards that only name it as a related stock follow, dashed and labelled "in a XYZ card".
 */
export default function CardChips({ cards, max = 4, symbol }: { cards: CardBrief[]; max?: number; symbol?: string | null }) {
  const { direct, related } = splitBySymbol(cards, symbol);
  const all = [...direct.map((c) => ({ c, related: false })), ...related.map((c) => ({ c, related: true }))];
  return (
    <>
      {all.slice(0, max).map(({ c, related: r }) => <CardChip key={c.id} c={c} related={r} />)}
      {all.length > max && <span className="small muted">+{all.length - max} more</span>}
    </>
  );
}
