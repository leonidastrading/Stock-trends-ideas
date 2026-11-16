import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import { toEt } from "@/lib/time";
import { AddForm, StatusButton } from "./WatchlistForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function WatchlistPage() {
  if (!hasDatabase()) return <SetupNotice />;
  await store.seedWatchlist();
  // Newest first in every group.
  const items = (await store.watchlist()).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const groups: Array<[string, typeof items]> = [["Proposed by the scout (waiting for you: auto-approve is off in Settings)", items.filter((i) => i.status === "proposed")], ["Active", items.filter((i) => i.status === "active")], ["Retired", items.filter((i) => i.status === "retired")]];
  return (
    <>
      <h1>Watch-list</h1>
      <section className="card notice small">Terms the daily scan measures on every source: brands, products, apps and themes, each with a kind and the tickers it points at. The scout adds terms it discovers and retires its own after 30 quiet days (switch to approving them yourself in Settings). Terms you add stay until you retire them. Nothing here needs your attention unless you want to add a term.</section>
      <section className="card"><h2>Add a term</h2><AddForm /></section>
      {groups.map(([title, rows]) => rows.length > 0 && (
        <section className="card" key={title}>
          <h2>{title}</h2>
          <p className="small muted" style={{ marginTop: -4 }}>Newest first · {rows.length} term{rows.length === 1 ? "" : "s"}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Term</th><th>Kind</th><th>Tickers</th><th>Added</th><th>By</th><th></th></tr></thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id}>
                    <td>{w.term}{w.note ? <div className="small muted">{w.note}</div> : null}</td><td className="small">{w.kind.replace("_", "-")}</td><td className="small">{w.tickers.join(", ")}</td>
                    <td className="small">{toEt(new Date(w.addedAt)).date}</td><td className="small">{w.addedBy}</td>
                    <td>{w.status === "proposed" && <><StatusButton id={w.id} action="approve" label="Approve" /> <StatusButton id={w.id} action="retire" label="Dismiss" /></>}{w.status === "active" && <StatusButton id={w.id} action="retire" label="Retire" />}{w.status === "retired" && <StatusButton id={w.id} action="reactivate" label="Reactivate" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
