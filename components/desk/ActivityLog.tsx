import LinkedText from "@/components/LinkedText";
import Pager, { FilterLinks, paginate } from "@/components/Pager";
import type { Candidate, StoredCard } from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

export const OUTCOMES = [
  { value: "", label: "All" }, { value: "promoted", label: "Promoted" }, { value: "late", label: "Late" }, { value: "not_promoted", label: "Not promoted" },
  { value: "rejected", label: "Rejected" }, { value: "duplicate", label: "Duplicate" }, { value: "error", label: "Error" },
];

/** Pure: one word for what happened to a candidate. */
export function outcomeOf(c: { outcome: string; reason: string | null }): string {
  if (c.outcome === "card") return c.reason ?? "card";
  if (c.outcome === "rejected" && /^duplicate/.test(c.reason ?? "")) return "duplicate";
  return c.outcome;
}

/** Everything the scout considered in the window, including rejections and why; filter by outcome, 50 a page. Folded by default. */
export default function ActivityLog({ candidates, cards, params, outcome, lpage, cardHref }: { candidates: Candidate[]; cards: StoredCard[]; params: Record<string, string | undefined>; outcome: string; lpage: number; cardHref: (id: number) => string }) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows = candidates.filter((c) => !outcome || outcomeOf(c) === outcome);
  const log = paginate(rows, lpage, 50);
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(outcomeOf(c), (counts.get(outcomeOf(c)) ?? 0) + 1);
  return (
    <details className="card section" id="log" open={!!outcome || lpage > 1}>
      <summary><h2>Activity log</h2> <span className="small muted">everything considered, including rejections and why · {rows.length} of {candidates.length}</span></summary>
      <div className="toolbar">
        <FilterLinks params={params} name="lo" value={outcome} reset={["lpage"]} options={OUTCOMES.map((o) => ({ ...o, count: o.value ? counts.get(o.value) ?? 0 : candidates.length }))} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Origin</th><th>Term</th><th>Outcome</th><th>Why</th></tr></thead>
          <tbody>
            {log.items.map((c) => (
              <tr key={c.id}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtEtAgo(c.createdAt)}</td>
                <td className="small">{c.origin}</td>
                <td>{c.term}{c.observation ? <div className="small muted">“{c.observation}”</div> : null}</td>
                <td><span className={`tag ${c.outcome === "card" ? (c.reason ?? "") : c.outcome}`}>{c.outcome === "card" ? c.reason?.replace("_", " ") : c.outcome}</span>{c.cardId ? <a className="small" href={cardHref(c.cardId)}>#{c.cardId}</a> : null}</td>
                <td className="small secondary">{c.outcome === "card" ? byId.get(c.cardId!)?.gateNotes.join(" · ") : <LinkedText text={c.reason} />}{c.trigger?.length ? <div className="muted">flagged by: {c.trigger.map((s) => `${s.source} ${s.changeVs12m === null ? "" : `${s.changeVs12m >= 0 ? "+" : ""}${Math.round(s.changeVs12m * 100)}%`}`).join(", ")}</div> : null}</td>
              </tr>
            ))}
            {log.items.length === 0 && <tr><td colSpan={5} className="muted">Nothing matches in this window.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager params={params} name="lpage" page={log.page} pages={log.pages} total={log.total} label="logged" hash="#log" />
    </details>
  );
}
