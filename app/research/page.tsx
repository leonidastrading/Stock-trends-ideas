import Direction from "@/components/Direction";
import LinkedText from "@/components/LinkedText";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { paperResult } from "@/lib/scout/paper-result";
import { fromCandidates, isStale, listRequests, type ResearchRequest } from "@/lib/scout/research-requests";
import * as store from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";
import ResearchForm, { RefreshWhileRunning } from "./ResearchForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Research: ask the scout about a stock or an idea, and every research you started from any tab, with its result. */
export default async function ResearchPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [logged, cards, tracks, cands] = await Promise.all([listRequests(200).catch(() => [] as ResearchRequest[]), store.cardsSince(365), store.allTracks(), store.candidatesSince(120).catch(() => [] as store.Candidate[])]);
  const now = new Date();
  // Research from before requests were logged comes from the scout's own record, in the same list.
  const first = logged.length ? logged[logged.length - 1].createdAt : now.toISOString();
  const requests = [...logged, ...fromCandidates(cands, first)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const track = new Map(tracks.map((t) => [t.cardId, t]));
  const running = requests.some((r) => r.status === "running" && !isStale(r, now));

  const result = (c: store.StoredCard) => {
    const t = track.get(c.id);
    const r = t ? paperResult(t, null, null) : null;
    return (
      <>
        <Direction direction={c.direction} ticker={c.primaryTicker} size="small" /> <a href={`/cards/${c.id}`}>{c.title}</a>{" "}
        <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span>
        {r?.closed && <span className={`small ${r.ret >= 0 ? "pos" : "neg"}`}> {r.ret >= 0 ? "+" : "−"}{Math.abs(r.ret * 100).toFixed(1)}%</span>}
        {t?.invalidatedAt && <span className="tag neg">invalidated</span>}
      </>
    );
  };

  return (
    <>
      <h1>Research</h1>
      <p className="small secondary">Ask the scout about a stock or an idea. It measures it on every source, writes a thesis card and runs the gates, in the background (a minute or two). Everything you send to research from any tab (the &quot;Research it&quot; buttons on News, Filings, Pharma, Court, Dots, Themes, Rumors and Investigate) is listed here too, and the red badge on this tab counts results that came back since you last looked. Your cards are scored as yours. You can upload a document here too. Long pasted pages and screenshots go on <a href="/notice">I noticed something</a>; open-ended digging on <a href="/investigate">Investigate</a>.</p>
      <section className="card"><ResearchForm /></section>
      <RefreshWhileRunning running={running} />
      <section className="card">
        <h2>Your research</h2>
        {requests.length === 0 ? <p className="small muted">Nothing yet. Research a stock above, or press &quot;Research it&quot; on any tab.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Asked</th><th>What</th><th>From</th><th>Result</th></tr></thead>
            <tbody>{requests.map((r) => {
              const c = r.cardId ? byId.get(r.cardId) : undefined;
              const stale = isStale(r, now);
              return (
                <tr key={r.id} className={r.status === "running" && !stale ? "muted" : undefined}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtEtAgo(r.createdAt)}</td>
                  <td className="small">{r.tickers.length > 0 && <>{r.tickers.map((t, i) => <span key={t}>{i ? ", " : ""}<Ticker symbol={t} /></span>)} · </>}{r.term}</td>
                  <td className="small">{r.fromUrl ? <a href={r.fromUrl}>{r.fromLabel ?? "link"}</a> : r.fromLabel ?? "—"}</td>
                  <td className="small">
                    {r.status === "running" ? (stale ? <span className="neg">did not finish (the server stopped it); try again</span> : <span className="warn">researching… a minute or two</span>)
                      : c ? result(c)
                      : r.cardId ? <a href={`/cards/${r.cardId}`}>card #{r.cardId}{r.cardStatus ? ` (${r.cardStatus.replace("_", " ")})` : ""}</a>
                      : <span className={r.status === "rejected" ? "muted" : "neg"}><LinkedText text={r.reason ?? r.status} /></span>}
                    {r.finishedAt && r.status !== "running" && <span className="muted"> · done {fmtEtAgo(r.finishedAt)}</span>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
