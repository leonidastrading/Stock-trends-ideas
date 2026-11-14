import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { trackRecord } from "@/lib/scout/inbox-record";
import { botPrompt, INBOX_EXAMPLE, INBOX_FIELDS } from "@/lib/scout/inbox-spec";
import * as store from "@/lib/scout/store";
import { fmtEt } from "@/lib/time";
import ImportForm from "../notice/ImportForm";
import CopyBox from "./CopyBox";
import CopyLine from "./CopyLine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function InboxPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const repo = process.env.GITHUB_INBOX_REPO?.trim() || null;
  const path = (process.env.GITHUB_INBOX_PATH?.trim() || "inbox").replace(/^\/|\/$/g, "");
  const tokenSet = !!process.env.GITHUB_INBOX_TOKEN?.trim();
  const [files, runs, cards] = await Promise.all([store.inboxRecent(100), store.runsByAction("import", 100), store.cardsSince(365)]);
  const rows = trackRecord(files, runs);
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const base = (process.env.DASHBOARD_URL?.trim() || "https://<this app>").replace(/\/$/, "");
  return (
    <>
      <h1>Inbox</h1>
      <section className="card notice small">
        Other bots can send the scout ideas as files. Each idea is researched with the scout&apos;s own data, logged as a thesis card that is never edited, gated like everything else, tracked on paper against SPY, and scored as <b>&quot;Your bot&quot;</b> on the Scoreboard. Nothing places an order.
        <div style={{ marginTop: 6 }}>
          {repo ? <>Watching <b>{repo}</b>, folder <code>{path}/</code>{tokenSet ? "" : <span className="warn"> · no GITHUB_INBOX_TOKEN set: works only if the repo is public</span>}. New files are read on the next hourly call, or now with &quot;Check the GitHub inbox&quot; on Settings.</>
            : <span className="warn">Not connected yet: set GITHUB_INBOX_REPO (owner/name) and GITHUB_INBOX_TOKEN (fine-grained, read-only Contents on that repo) in Vercel and redeploy.</span>}
        </div>
      </section>

      {repo && (
        <section className="card">
          <h2>Upload address</h2>
          <CopyLine label="Repository (give this to your bot)" text={`https://github.com/${repo}`} />
          <CopyLine label="Folder for the files" text={`${path}/`} />
        </section>
      )}

      <section className="card">
        <h2>Track record</h2>
        <p className="small secondary">Every document received, newest first, and what the scout did with each idea.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Received</th><th>Document</th><th>How it was read</th><th className="num">Ideas</th><th>What the scout did</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.receivedAt}${r.label}`}>
                <td className="small">{fmtEt(r.receivedAt)}</td>
                <td className="small"><b>{r.label}</b><div className="muted">{r.how === "github" ? r.file : "pasted on the page or posted to the import"}</div></td>
                <td className="small">{r.error ? <span className="neg">{r.error}</span> : r.read}</td>
                <td className="num">{r.ideas ?? "—"}</td>
                <td className="small">
                  {r.outcomes.length ? (
                    <details>
                      <summary>{summary(r.outcomes)}{r.researchedAt ? ` · done ${fmtEt(r.researchedAt)}` : ""}</summary>
                      <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                        {r.outcomes.map((o, i) => {
                          const c = o.cardId ? cardById.get(o.cardId) : undefined;
                          return (
                            <li key={i}>
                              {o.term.replace(/^inbox: |^stream (host|agent): /, "")}: {o.cardId ? <a href={`/candidates?days=365#card-${o.cardId}`}>{c ? `${c.direction === "long" ? "▲" : "▼"} ${c.primaryTicker}, ` : ""}{o.outcome.replace(/^card: /, "")}</a> : <span className="muted">{o.outcome}{o.reason ? ` (${o.reason})` : ""}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  ) : r.error ? "—" : r.researchStatus === "queued" ? "sent to research; results appear here when done" : r.researchStatus ?? "no ideas found"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">Nothing received yet.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Instructions for a bot</h2>
        <p className="small secondary">Give this to any bot that should send the scout ideas. It writes one JSON file per upload into the inbox folder.</p>
        <CopyBox text={botPrompt(repo, path)} label="Copy the prompt" />
      </section>

      <section className="card">
        <h2>File format</h2>
        <p className="small secondary">One JSON object per file, named <code>{path}/YYYY-MM-DD-&lt;bot-name&gt;.json</code>; a new name for every upload. Up to 12 ideas. Markdown, text or PDF files are read too (the model then pulls the ideas out of the prose), but JSON is read exactly as written.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Field</th><th></th><th>What it holds</th></tr></thead>
          <tbody>{INBOX_FIELDS.map((f) => <tr key={f.name}><td><code>{f.name}</code></td><td className="small">{f.required ? "required" : "optional"}</td><td className="small">{f.about}</td></tr>)}</tbody>
        </table></div>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8 }}>{JSON.stringify(INBOX_EXAMPLE, null, 2)}</pre>
      </section>

      <section className="card">
        <h2>Without GitHub</h2>
        <p className="small secondary">A bot that can make web requests can send the same JSON directly:</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{`POST ${base}/api/cron/import
Authorization: Bearer <CRON_SECRET>
Content-Type: application/json

{ "text": "<the JSON file's contents as a string>", "label": "2026-11-16-my-research-bot" }`}</pre>
        <p className="small secondary">Or paste it here yourself:</p>
        <ImportForm />
      </section>
    </>
  );
}

function summary(o: Array<{ outcome: string }>): string {
  const n = (re: RegExp) => o.filter((x) => re.test(x.outcome)).length;
  const parts = [[n(/card: promoted/), "promoted"], [n(/card: late/), "late"], [n(/card: not_promoted/), "not promoted"], [n(/^rejected/), "rejected"], [n(/^(error|capped)/), "failed"]] as const;
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(" · ") || `${o.length} idea(s)`;
}
