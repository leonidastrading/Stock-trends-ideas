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
  const items = await store.watchlist();
  const groups: Array<[string, typeof items]> = [["Proposed by the scout (approve to start measuring)", items.filter((i) => i.status === "proposed")], ["Active", items.filter((i) => i.status === "active")], ["Retired", items.filter((i) => i.status === "retired")]];
  return (
    <>
      <h1>Watch-list</h1>
      <section className="card notice small">Terms the daily scan measures on every source: brands, products, apps and themes, each with a kind and the tickers it points at. The scout may propose additions; you approve them.</section>
      <section className="card"><h2>Add a term</h2><AddForm /></section>
      {groups.map(([title, rows]) => rows.length > 0 && (
        <section className="card" key={title}>
          <h2>{title}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Term</th><th>Kind</th><th>Tickers</th><th>Added</th><th>By</th><th></th></tr></thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id}>
                    <td>{w.term}{w.note ? <div className="small muted">{w.note}</div> : null}</td><td className="small">{w.kind.replace("_", "-")}</td><td className="small">{w.tickers.join(", ")}</td>
                    <td className="small">{toEt(new Date(w.addedAt)).date}</td><td className="small">{w.addedBy}</td>
                    <td>{w.status === "proposed" && <StatusButton id={w.id} action="approve" label="Approve" />}{w.status === "active" && <StatusButton id={w.id} action="retire" label="Retire" />}{w.status === "retired" && <StatusButton id={w.id} action="reactivate" label="Reactivate" />}</td>
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
