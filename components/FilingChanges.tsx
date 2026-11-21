import Ticker from "@/components/Ticker";
import { recentDiffs } from "@/lib/scout/filing-diff";
import { fmtEtAgo } from "@/lib/time";

const FLAG: Record<string, [string, string]> = { red_flag: ["red flag", "error"], positive: ["positive", "ok"], mixed: ["mixed", "late"], routine: ["routine", ""], no_prior: ["no prior year", ""], error: ["not read", ""] };

/** Filings page: every 10-K / 10-Q the filing-change reader compared with a year earlier, newest first. */
export default async function FilingChanges() {
  const diffs = await recentDiffs(60).catch(() => []);
  const notable = diffs.filter((d) => d.read && d.flag !== "routine");
  const rest = diffs.filter((d) => !notable.includes(d));
  return (
    <section className="card" id="changes">
      <h2>Filing changes: this year&apos;s 10-K / 10-Q vs last year&apos;s</h2>
      <p className="small muted">
        For every stock on a card, and a weekly batch of 10 small caps (public float $300M–$2B) that just filed, the scout compares the new report with the same one a year earlier: risk factors, legal proceedings and MD&amp;A, paragraph by paragraph (numbers ignored),
        plus words like capacity, backlog, allocation, going concern, and customers named as a share of revenue. When something changed, the AI reads the changes and flags them. A red flag on a stock with an open card is pushed to your phone; a specific, material small-cap change goes to research (at most 3 a week).
        The research behind it (&quot;Lazy Prices&quot;) has weakened in recent tests, so this is a red-flag tool, not a buy or sell signal.
      </p>
      {notable.length === 0 && <p className="small muted">{diffs.length ? "Nothing notable yet: the filings read so far changed little." : "Nothing read yet: the reader runs every half hour and works through card stocks first."}</p>}
      {notable.map((d) => (
        <div key={d.accession} id={`diff-${d.accession}`} className="small" style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          <span className={`tag ${FLAG[d.flag]?.[1] ?? ""}`}>{FLAG[d.flag]?.[0] ?? d.flag}</span> {d.ticker ? <Ticker symbol={d.ticker} /> : null} <b>{d.company}</b> · <a href={d.url} target="_blank" rel="noreferrer">{d.form} filed {d.filed}</a> vs <a href={d.priorUrl ?? "#"} target="_blank" rel="noreferrer">{d.priorFiled}</a>
          <span className="muted"> · {d.source === "smallcap" ? "small-cap batch" : "card stock"} · risk-factor similarity {d.similarity ?? "?"} · {d.added} paragraphs added, {d.removed} removed · read {fmtEtAgo(d.createdAt)}</span>
          <div><b>{d.read!.headline}</b></div>
          {d.read!.findings.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{d.read!.findings.map((f, i) => <li key={i}><span className={f.direction === "negative" ? "neg" : f.direction === "positive" ? "pos" : "muted"}>{f.type.replace("_", " ")}</span> · {f.why} <span className="muted history-note">“{f.quote}”</span></li>)}</ul>}
          {d.read!.research && <div className="muted">Worth researching ({d.read!.research_direction}): {d.read!.research_why}</div>}
          {d.mechanical && (d.mechanical.customers.added.length > 0 || d.mechanical.customers.dropped.length > 0) && <div className="muted">Customers named as a share of revenue: new {d.mechanical.customers.added.join(", ") || "none"}; dropped {d.mechanical.customers.dropped.join(", ") || "none"}.</div>}
          {d.mechanical && d.mechanical.shifts.length > 0 && <div className="muted">Watch words per 10k words (last year → now): {d.mechanical.shifts.map((s) => `${s.word} ${s.before}→${s.after}`).join(" · ")}</div>}
        </div>
      ))}
      {rest.length > 0 && <details className="small"><summary>Little or no change ({rest.length})</summary><ul>{rest.map((d) => <li key={d.accession} id={`diff-${d.accession}`}>{d.ticker ?? d.cik} · <a href={d.url} target="_blank" rel="noreferrer">{d.form} {d.filed}</a> · {d.flag === "no_prior" ? "no comparable filing a year earlier" : d.flag === "error" ? `not read: ${d.error}` : `similarity ${d.similarity ?? "?"}${d.error ? ` (${d.error})` : ""}`} <span className="muted">· {d.source === "smallcap" ? "small cap" : "card stock"}</span></li>)}</ul></details>}
    </section>
  );
}
