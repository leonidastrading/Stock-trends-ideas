import { after } from "next/server";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { trackRecord } from "@/lib/scout/inbox-record";
import { botPrompt, INBOX_EXAMPLE, INBOX_FIELDS } from "@/lib/scout/inbox-spec";
import * as store from "@/lib/scout/store";
import { DIGEST_DAYS, itemMeta, label, rank, shortSource, type Digest } from "@/lib/scout/inbox-digest";
import { etLabel, fmtEt, toEt } from "@/lib/time";
import ImportForm from "../notice/ImportForm";
import CopyBox from "./CopyBox";
import RefreshDigest from "./RefreshDigest";
import Ticker from "@/components/Ticker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export default async function InboxPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const repo = process.env.GITHUB_INBOX_REPO?.trim() || null;
  const path = (process.env.GITHUB_INBOX_PATH?.trim() || "inbox").replace(/^\/|\/$/g, "");
  const tokenSet = !!process.env.GITHUB_INBOX_TOKEN?.trim();
  const [files, runs, cards] = await Promise.all([store.inboxRecent(100), store.runsByAction("import", 100), store.cardsSince(365)]);
  const rows = trackRecord(files, runs);
  // When each document arrived, by its label, for the summary's time stamps.
  const received = new Map<string, string>();
  for (const f of files) if (!received.has(label(f.path))) received.set(label(f.path), f.readAt);
  // Files in the repo not read yet (one GitHub call; skipped quietly if the repo cannot be listed).
  const waiting = await (async () => {
    const { inboxConfig, listInbox, pickFiles } = await import("@/lib/scout/inbox");
    const cfg = inboxConfig();
    if (!cfg) return [] as string[];
    try {
      return pickFiles(await listInbox(cfg), await store.inboxSeen()).map((p) => p.use.path);
    } catch {
      return [] as string[];
    }
  })();
  // Files waiting: start reading them now, in the background, rather than at the next hourly check.
  if (waiting.length) {
    after(async () => {
      const [{ pollInbox }, { defaultDeps }] = await Promise.all([import("@/lib/scout/inbox"), import("@/lib/scout/engine")]);
      await pollInbox(defaultDeps(), 50, fetch, undefined, Date.now() + 240_000).catch(() => undefined);
    });
  }
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const digest = await store.latestInboxDigest<Digest>().catch(() => null);
  const today = toEt(new Date()).date;
  // Documents but no summary yet (they came before the summary existed): write one now, in the background.
  if (!digest && files.length) {
    after(async () => {
      const [{ refreshInboxDigest }, { defaultDeps }] = await Promise.all([import("@/lib/scout/inbox-digest"), import("@/lib/scout/engine")]);
      await refreshInboxDigest(defaultDeps()).catch(() => undefined);
    });
  }
  const ideas = digest ? rank(digest.digest.ideas, today) : [];
  const news = digest ? rank(digest.digest.news, today) : [];
  const base =(process.env.DASHBOARD_URL?.trim() || "https://<this app>").replace(/\/$/, "");
  return (
    <>
      <h1>Inbox</h1>
      <div className="panel-head" style={{ margin: "0 0 8px" }}>
        <span className="small secondary">{digest ? <details className="digest-docs"><summary>Summary of {digest.docs.length} document{digest.docs.length === 1 ? "" : "s"} from the last {DIGEST_DAYS} days · written {fmtEt(digest.createdAt)}</summary>{digest.docs.map((d) => <div key={d}>{shortSource(d)} <span className="muted">· {received.get(d) ? `received ${etLabel(received.get(d)!)}` : d.slice(0, 10)}</span></div>)}</details> : files.length ? "Writing the first summary of your documents… refresh in a minute." : "The summary appears after the first documents arrive."}</span>
        <RefreshDigest />
      </div>
      {digest && (
        <div className="panels-grid digest-grid">
          <section className="card panel">
            <div className="panel-head"><span>Top ideas</span><span className="small muted">breaking, important and recent first</span></div>
            {ideas.length === 0 && <p className="small muted">No ideas in these documents.</p>}
            {ideas.map((x, i) => {
              const c = x.card_id ? cardById.get(x.card_id) : undefined;
              return (
                <div key={i} className="digest-item">
                  <div>
                    {x.breaking && <span className="tag not_promoted">breaking</span>}
                    <b className={x.direction === "long" ? "pos" : x.direction === "short" ? "neg" : ""}>{x.direction === "long" ? "▲ " : x.direction === "short" ? "▼ " : ""}</b>{x.tickers.slice(0, 4).map((tk, j) => <span key={tk}>{j ? ", " : ""}<Ticker symbol={tk} className={x.direction === "long" ? "pos" : x.direction === "short" ? "neg" : "accent"} /></span>)} <b>{x.title}</b>
                  </div>
                  <div className="small">{x.summary}</div>
                  <div className="small muted">
                    {itemMeta(x, received)}
                    {c ? <> · <a href={`/ideas?days=365&card=${c.id}#card-${c.id}`}>card #{c.id} ({c.status.replace("_", " ")})</a></> : null}
                  </div>
                </div>
              );
            })}
          </section>
          <section className="card panel">
            <div className="panel-head"><span>News</span><span className="small muted">breaking, important and recent first</span></div>
            {news.length === 0 && <p className="small muted">No news in these documents.</p>}
            {news.map((x, i) => (
              <div key={i} className="digest-item">
                <div>{x.breaking && <span className="tag not_promoted">breaking</span>}<b>{x.headline}</b>{x.tickers.length ? <span className="small"> · {x.tickers.slice(0, 4).map((tk, j) => <span key={tk}>{j ? ", " : ""}<Ticker symbol={tk} /></span>)}</span> : null}</div>
                <div className="small">{x.summary}</div>
                <div className="small muted">{itemMeta(x, received)}</div>
              </div>
            ))}
          </section>
        </div>
      )}

      <section className="card notice small">
        Other bots can send the scout ideas as files. Each idea is researched with the scout&apos;s own data, logged as a thesis card that is never edited, gated like everything else, tracked on paper against SPY, and scored as <b>&quot;Your bot&quot;</b> on the Scoreboard. Nothing places an order.
        <div style={{ marginTop: 6 }}>
          {repo ? <>Watching <b>{repo}</b>, folder <code>{path}/</code>{tokenSet ? "" : <span className="warn"> · no GITHUB_INBOX_TOKEN set: works only if the repo is public</span>}. New files are read on the next hourly call, or now with &quot;Check the GitHub inbox&quot; on Settings.</>
            : <span className="warn">Not connected yet: set GITHUB_INBOX_REPO (owner/name) and GITHUB_INBOX_TOKEN (fine-grained, read-only Contents on that repo) in Vercel and redeploy.</span>}
        </div>
      </section>

      <section className="card">
        <h2>Track record</h2>
        <p className="small secondary">Every document received, newest first, and what the scout did with each idea.</p>
        {waiting.length > 0 && <p className="small warn">Reading now: {waiting.join(", ")}. Opening this page starts the read; refresh in a minute or two to see them here (text and PDF files take longer than JSON, because the model pulls the ideas out of the prose).</p>}
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
                              {o.term.replace(/^inbox: |^stream (host|agent): /, "")}: {o.cardId ? <a href={`/ideas?days=365&card=${o.cardId}#card-${o.cardId}`}>{c ? `${c.direction === "long" ? "▲" : "▼"} ${c.primaryTicker}, ` : ""}{o.outcome.replace(/^card: /, "")}</a> : <span className="muted">{o.outcome}{o.reason ? ` (${o.reason})` : ""}</span>}
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
