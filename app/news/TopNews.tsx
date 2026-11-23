import CardChips from "@/components/CardChips";
import NewFlag, { SeenScope } from "@/components/NewFlag";
import Ticker from "@/components/Ticker";
import type { CardBrief } from "@/lib/scout/store";
import { BROAD_FUNDS, type TopNews as Top } from "@/lib/scout/top-news";
import { ago, toEt } from "@/lib/time";

const clock = (iso: string) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return toEt(d).date === toEt(new Date()).date ? `${t} ET` : `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" })} ${t} ET`;
};

/** A story is the same one when its headline is, whichever feed or copy it came from. */
const seenKey = (p: { headline: string }) => p.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

/** The top of the News tab: the ten most important stories of the last 24 hours. */
export default function TopNews({ top, cards }: { top: Top; cards: CardBrief[] }) {
  if (!top.picks.length) return null;
  // The scout's promoted cards (last 60 days) whose own stock is in the story; never via index funds like SPY or QQQ.
  const since = Date.now() - 60 * 86400_000;
  const cardsOn = (syms: string[]) => {
    const own = syms.filter((s) => !BROAD_FUNDS.has(s));
    return cards.filter((c) => c.status === "promoted" && Date.parse(c.createdAt) >= since && own.includes(c.primaryTicker));
  };
  return (
    <section className="card top-news">
      <h2>Top news · last 24 hours</h2>
      <p className="small muted">
        {top.by === "ai" ? `The ten stories that matter most today, picked by the AI from the day's strongest headlines (updated ${ago(top.at)}, every half hour).` : "The day's strongest stories by the News tab's ranking (the AI's pick appears within half an hour)."}
      </p>
      <SeenScope name="topnews" keys={top.picks.map(seenKey)}>
      <ol className="top-news-list">
        {top.picks.map((p) => (
          <li key={p.id}>
            <NewFlag k={seenKey(p)} /><a className="top-news-head" href={p.url} target="_blank" rel="noreferrer">{p.headline}</a>
            <div className="small">
              {p.why && <span className="secondary">{p.why}</span>}
              <span className="muted"> · {clock(p.at)} · {p.source}</span>
              {p.symbols.length > 0 && <> · {p.symbols.map((s, i) => <span key={s}>{i ? " " : ""}<Ticker symbol={s} /></span>)}</>}
            </div>
            {cardsOn(p.symbols).length > 0 && <div className="small top-news-cards"><span className="muted">Scout cards: </span><CardChips cards={cardsOn(p.symbols)} max={3} /></div>}
          </li>
        ))}
      </ol>
      </SeenScope>
    </section>
  );
}
