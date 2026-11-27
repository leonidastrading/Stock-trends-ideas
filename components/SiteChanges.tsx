import CardChips from "@/components/CardChips";
import Ticker from "@/components/Ticker";
import * as store from "@/lib/scout/store";
import { siteChanges, type SiteChange } from "@/lib/scout/site-watch";
import { fmtEtAgo } from "@/lib/time";

const DIR: Record<string, [string, string]> = { negative: ["negative", "error"], positive: ["positive", "ok"], mixed: ["mixed", "late"], routine: ["routine", ""] };

/** Filings page: quiet edits to the websites of stocks with open cards (investor, customers, careers, pricing, product pages). */
export default async function SiteChanges() {
  const [changes, briefs] = await Promise.all([siteChanges(null, 120, 40).catch(() => [] as SiteChange[]), store.cardBriefsSince(365).catch(() => [] as store.CardBrief[])]);
  const cardsOn = (sym: string) => briefs.filter((c) => c.primaryTicker === sym || c.tickers.includes(sym));
  return (
    <section className="card" id="website-changes">
      <h2>Website changes</h2>
      <p className="small muted">
        For each stock with an open card, the scout reads the company&apos;s home, investor, press, customers, careers, pricing and product pages about once a week and compares them with the last reading
        (the first time, with the Wayback Machine&apos;s copy from about three months earlier). A deleted press release, a softened claim, a customer removed or hiring frozen often shows on the site before any filing.
        When enough text changed, the AI reads what was removed and added; the new version is saved to the Wayback Machine so it stays checkable.
      </p>
      {changes.length === 0 && <p className="small muted">No notable website changes yet. The reader checks three companies every half hour.</p>}
      {changes.map((w) => (
        <div key={w.id} className="small" style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          <span className={`tag ${DIR[w.read?.direction ?? ""]?.[1] ?? ""}`}>{DIR[w.read?.direction ?? ""]?.[0] ?? "changed"}</span> <Ticker symbol={w.symbol} /> <b>{w.kind} page</b> · <a href={w.url} target="_blank" rel="noreferrer">now</a>
          {w.oldUrl ? <> · <a href={w.oldUrl} target="_blank" rel="noreferrer">before ({w.oldDate})</a></> : <span className="muted"> · compared with the {w.oldDate}</span>}
          {w.newUrl ? <> · <a href={w.newUrl} target="_blank" rel="noreferrer">saved copy</a></> : null}
          <span className="muted"> · found {fmtEtAgo(w.foundAt)}</span>
          {w.read?.headline ? <div><b>{w.read.headline}</b></div> : null}
          {w.read?.findings.length ? <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{w.read.findings.map((f, i) => <li key={i}>{f.what} <span className="muted history-note">“{f.quote}”</span></li>)}</ul> : null}
          {!w.read && <details><summary>{w.removed.length} lines removed, {w.added.length} added (not read by the AI)</summary><ul>{w.removed.slice(0, 8).map((l, i) => <li key={`r${i}`} className="neg">− {l}</li>)}{w.added.slice(0, 8).map((l, i) => <li key={`a${i}`} className="pos">+ {l}</li>)}</ul></details>}
          {cardsOn(w.symbol).length > 0 && <div>Scout cards on {w.symbol}: <CardChips cards={cardsOn(w.symbol)} max={6} symbol={w.symbol} /></div>}
        </div>
      ))}
    </section>
  );
}
