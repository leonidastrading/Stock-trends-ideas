import CardView from "@/components/CardView";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { opposingCalls, upcomingCatalysts } from "@/lib/scout/calendar";
import * as store from "@/lib/scout/store";
import ImportForm from "./ImportForm";
import NoticeForm from "./NoticeForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NoticePage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [cards, tracks, spend, fb, inbox] = await Promise.all([store.cardsSince(90), store.allTracks(), store.spendByDay(1), store.latestFeedback(), store.inboxRecent(10)]);
  const inboxRepo = process.env.GITHUB_INBOX_REPO?.trim();
  const opp = opposingCalls(cards, tracks);
  const reviews = await store.allReviews();
  const human = cards.filter((c) => c.origin === "human").slice(0, 10);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  return (
    <>
      <h1>I noticed something</h1>
      <section className="card notice small">
        The method starts with a person noticing something. Type it here; the scout measures it on every source, writes a thesis card and runs the gates, usually within a few minutes.
        These cards are tagged human-originated and scored on their own, so after six months you can see whether the research adds anything to what you noticed yourself.
        {spend[0] ? <div className="muted" style={{ marginTop: 6 }}>LLM spend today: ${spend[0].cost.toFixed(2)} over {spend[0].calls} calls.</div> : null}
      </section>
      <section className="card"><NoticeForm /></section>
      <section className="card">
        <h2>GitHub inbox</h2>
        {inboxRepo ? (
          <p className="small secondary">Your bot commits files (PDF, JSON, Markdown or text) to <code>{inboxRepo}/{process.env.GITHUB_INBOX_PATH?.trim() || "inbox"}</code>. Each new file is read once on the next hourly call (or &quot;Check the GitHub inbox&quot; on Settings); the ideas in it are researched like the stream file and scored as &quot;Your bot&quot; on the Scoreboard. A text file with the same name as a PDF is used instead of the PDF.</p>
        ) : <p className="small secondary">Not set up. Set <code>GITHUB_INBOX_REPO</code> (owner/name) and <code>GITHUB_INBOX_TOKEN</code> (read-only) in Vercel, and have your bot commit files to an <code>inbox/</code> folder in that repo.</p>}
        {inbox.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Read</th><th>File</th><th>Result</th></tr></thead>
            <tbody>{inbox.map((f) => <tr key={f.path + f.readAt}><td className="small">{f.readAt.slice(0, 16).replace("T", " ")}Z</td><td className="small">{f.path}</td><td className="small">{f.result?.error ? <span className="neg">{String(f.result.error)}</span> : f.result?.ideas !== undefined ? `${f.result.ideas} idea(s) via ${f.result.via === "block" ? "the JSON block" : "the model"} · ${String(f.result.sent ?? "")}` : String(f.result?.via ?? "")}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="card"><h2>Import the daily stream file</h2><ImportForm /></section>
      {human.length > 0 && <h2>Your recent cards</h2>}
      {human.map((c) => <CardView key={c.id} c={c} track={t.get(c.id) ?? null} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} />)}
    </>
  );
}
