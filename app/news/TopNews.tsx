import Ticker from "@/components/Ticker";
import type { TopNews as Top } from "@/lib/scout/top-news";
import { ago, toEt } from "@/lib/time";

const clock = (iso: string) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return toEt(d).date === toEt(new Date()).date ? `${t} ET` : `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" })} ${t} ET`;
};

/** The top of the News tab: the ten most important stories of the last 24 hours. */
export default function TopNews({ top }: { top: Top }) {
  if (!top.picks.length) return null;
  return (
    <section className="card top-news">
      <h2>Top news · last 24 hours</h2>
      <p className="small muted">
        {top.by === "ai" ? `The ten stories that matter most today, picked by the AI from the day's strongest headlines (updated ${ago(top.at)}, every half hour).` : "The day's strongest stories by the News tab's ranking (the AI's pick appears within half an hour)."}
      </p>
      <ol className="top-news-list">
        {top.picks.map((p) => (
          <li key={p.id}>
            <a className="top-news-head" href={p.url} target="_blank" rel="noreferrer">{p.headline}</a>
            <div className="small">
              {p.why && <span className="secondary">{p.why}</span>}
              <span className="muted"> · {clock(p.at)} · {p.source}</span>
              {p.symbols.length > 0 && <> · {p.symbols.map((s, i) => <span key={s}>{i ? " " : ""}<Ticker symbol={s} /></span>)}</>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
