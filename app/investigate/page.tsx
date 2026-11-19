import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { listInvestigations, reportText, type Investigation } from "@/lib/scout/investigate";
import CardAsk from "@/components/CardAsk";
import DigDeeper from "./DigDeeper";
import * as store from "@/lib/scout/store";
import { etLabelAgo } from "@/lib/time";
import ExposureResearch from "./ExposureResearch";
import { inline } from "@/app/chat/render";
import { tickersIn } from "@/lib/scout/ticker-words";
import type { ReactNode } from "react";
import InvestigateForm from "./InvestigateForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Record<string, [string, string]> = { confirmed: ["confirmed by records", "pos"], partly: ["partly confirmed", "warn"], unconfirmed: ["the story only", "muted"] };
const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString("en-US")}`);
const link = (s: string) => /^https?:\/\//.test(s) ? <a href={s} target="_blank" rel="noreferrer">record</a> : <span>{s}</span>;

/** Investigations: follow the money behind a story, in public records. */
export default async function InvestigatePage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [invs, cands, cards] = await Promise.all([listInvestigations(30), store.candidatesSince(120), store.cardsSince(120)]);
  const status = new Map(cards.map((c) => [c.id, c.status]));
  const researched = new Map<string, { cardId: number | null; outcome: string }>();
  for (const c of cands) {
    const m = /^investigate: ([A-Z.]+) #(\d+)/.exec(c.term);
    if (m) researched.set(`${m[2]}:${m[1]}`, { cardId: c.cardId, outcome: c.cardId ? (status.get(c.cardId) ?? "card") : c.outcome });
  }
  // Every real ticker in the reports links to TradingView (and its newest card, once per report).
  const texts = invs.flatMap((i) => (i.report ? [i.report.what_happened, i.report.bottom_line, ...i.report.money_trail.map((m) => m.finding), ...i.report.listed.flatMap((x) => [x.why, x.catalyst]), ...i.report.open_questions] : []));
  const { known, cards: cardIds } = await tickersIn(texts, invs.flatMap((i) => i.report?.listed.map((x) => x.ticker) ?? []));
  return (
    <>
      <h1>Investigate</h1>
      <details className="card section">
        <summary><b>How this works</b> <span className="small muted">follow the money behind a story</span></summary>
        <div className="small secondary">
          <p>Paste a story, a video transcript, a thread or a question, or give a link to an article. The scout plans what to look up, pulls the public records, and writes a report:</p>
          <ul>
            <li><b>Federal contracts</b> (USAspending): who was paid, by which agency, for what, how much.</li>
            <li><b>Lobbying filings</b> (Senate LDA): who paid lobbyists, on which issues, which agencies they lobbied.</li>
            <li><b>PAC and campaign money</b> (FEC): who a company&apos;s PAC or a campaign gave money to. Set FEC_API_KEY (free from api.data.gov) for reliable results; the shared demo key allows only a few lookups an hour.</li>
            <li><b>Headlines</b> on the listed companies involved.</li>
          </ul>
          <p>Each finding is marked <span className="pos">confirmed by records</span>, <span className="warn">partly confirmed</span> or <span className="muted">the story only</span>, with a link to the record. Then it names the listed companies exposed and how. <b>Research</b> sends one to the normal research step; those cards score as &quot;Scout · investigations&quot;. Two AI calls per investigation, within the daily cap. Video sites block automated readers: paste the transcript (YouTube: … → Show transcript).</p>
        </div>
      </details>
      <InvestigateForm running={invs.some((i) => i.status === "running")} />
      {invs.length === 0 && <p className="small muted">No investigations yet.</p>}
      {invs.map((inv, i) => {
        const ctx = { cards: cardIds, shown: new Set<string>() };
        return <InvestigationView key={inv.id} inv={inv} open={i === 0} researched={researched} t={(s: string) => inline(s, known, ctx)} />;
      })}
    </>
  );
}

function InvestigationView({ inv, open, researched, t }: { inv: Investigation; open: boolean; researched: Map<string, { cardId: number | null; outcome: string }>; t: (s: string) => ReactNode[] }) {
  const r = inv.report;
  const rec = inv.records;
  const n = rec ? { contracts: rec.contracts.reduce((a, c) => a + c.awards.length, 0), lobbying: rec.lobbying.reduce((a, l) => a + l.filings.length, 0), pac: rec.pacs.reduce((a, p) => a + p.spending.length, 0) } : null;
  return (
    <details className="card section investigation" open={open}>
      <summary>
        <b>{r?.headline || inv.title}</b>{" "}
        {inv.status === "running" ? <span className="tag late">digging…</span> : inv.status === "error" ? <span className="tag down">failed</span> : null}
        <span className="small muted"> · {etLabelAgo(inv.createdAt)}{inv.costUsd ? ` · $${inv.costUsd.toFixed(2)}` : ""}</span>
      </summary>
      {inv.status === "error" && <p className="small neg">{inv.error}</p>}
      {inv.status === "running" && <p className="small muted">{inv.records ? "Records pulled; writing the report…" : inv.plan ? "Plan made; pulling contracts, lobbying and PAC records…" : "Planning what to look up…"}</p>}
      {r && (
        <>
          <p>{t(r.what_happened)}</p>
          <h3>Money trail</h3>
          <ul className="small">{r.money_trail.map((m, k) => <li key={k}><span className={`tag ${STATUS[m.status]?.[1] ?? ""}`}>{STATUS[m.status]?.[0] ?? m.status}</span> {t(m.finding)} <span className="muted">({link(m.source)})</span></li>)}</ul>
          <h3>Listed companies exposed</h3>
          {r.listed.length === 0 ? <p className="small muted">None found.</p> : (
            <ul className="small">
              {r.listed.map((x) => {
                const done = researched.get(`${inv.id}:${x.ticker}`);
                return (
                  <li key={x.ticker} style={{ marginBottom: 6 }}>
                    <Ticker symbol={x.ticker} className={x.direction === "long" ? "pos" : x.direction === "short" ? "neg" : "accent"} />{" "}
                    <span className={x.direction === "long" ? "pos" : x.direction === "short" ? "neg" : "muted"}>{x.direction === "long" ? "▲ long" : x.direction === "short" ? "▼ short" : "watch"}</span> · confidence {x.confidence} · {t(x.why)}
                    {x.catalyst && <span className="muted"> · catalyst: {t(x.catalyst)}{x.catalyst_date ? ` (${x.catalyst_date})` : ""}</span>}{" "}
                    {done ? (done.cardId ? <a href={`/ideas?days=120&card=${done.cardId}#card-${done.cardId}`}>card #{done.cardId} ({done.outcome.replace("_", " ")})</a> : <span className="muted">researched: {done.outcome}</span>) : <ExposureResearch id={inv.id} ticker={x.ticker} />}
                  </li>
                );
              })}
            </ul>
          )}
          {r.open_questions.length > 0 && <><h3>Open questions</h3><ul className="small secondary">{r.open_questions.map((x, k) => <li key={k}>{t(x)}</li>)}</ul></>}
          <p><b>Bottom line:</b> {t(r.bottom_line)}</p>
          <div className="investigation-follow">
            <CardAsk symbol={r.listed[0]?.ticker ?? ""} tickers={r.listed.map((x) => x.ticker)} noun="investigation" subject={`investigation #${inv.id} (${(r.headline || inv.title).slice(0, 120)})`} context={reportText(inv)} />
            <DigDeeper id={inv.id} previous={reportText(inv)} suggestions={r.open_questions} />
          </div>
        </>
      )}
      {rec && (
        <details className="small">
          <summary>Records pulled ({n!.contracts} contract awards, {n!.lobbying} lobbying filings, {n!.pac} PAC/campaign payments)</summary>
          {rec.contracts.map((c, k) => (
            <div key={`c${k}`} style={{ marginTop: 6 }}><b>Contracts, {c.query}</b>{c.error ? <span className="neg"> · {c.error}</span> : !c.awards.length ? <span className="muted"> · none</span> : null}
              {c.awards.map((a, j) => <div key={j}>{a.recipient}{a.ticker ? ` [${a.ticker}]` : ""} · {usd(a.amount)} · {a.agency}{a.subAgency ? ` / ${a.subAgency}` : ""} · {a.start} → {a.end} · <a href={a.url} target="_blank" rel="noreferrer">award</a> <span className="muted">{a.description.slice(0, 140)}</span></div>)}
            </div>
          ))}
          {rec.lobbying.map((l, k) => (
            <div key={`l${k}`} style={{ marginTop: 6 }}><b>Lobbying, client &quot;{l.client}&quot;</b>{l.error ? <span className="neg"> · {l.error}</span> : !l.filings.length ? <span className="muted"> · none</span> : null}
              {l.filings.map((f, j) => <div key={j}>{f.year} {f.period} · {f.registrant} · {f.amount !== null ? usd(f.amount) : "?"} · {f.issues.join(", ")} · <a href={f.url} target="_blank" rel="noreferrer">filing</a> <span className="muted">{f.agencies.join(", ")}</span></div>)}
            </div>
          ))}
          {rec.pacs.map((p, k) => (
            <div key={`p${k}`} style={{ marginTop: 6 }}><b>PAC / campaign, &quot;{p.name}&quot;</b>{p.error ? <span className="neg"> · {p.error}</span> : !p.committees.length ? <span className="muted"> · no committee found</span> : <span className="muted"> · {p.committees.map((c) => c.name).join("; ")}</span>}
              {p.spending.slice(0, 25).map((s, j) => <div key={j}>{s.date} · {s.committee} → {s.recipient}{s.candidate ? ` (${s.candidate})` : ""} · {usd(s.amount)} · {s.purpose} · <a href={s.url} target="_blank" rel="noreferrer">FEC</a></div>)}
            </div>
          ))}
        </details>
      )}
      <details className="small"><summary>What you pasted</summary><div className="muted" style={{ whiteSpace: "pre-wrap" }}>{inv.input.slice(0, 4000)}{inv.input.length > 4000 ? "…" : ""}</div></details>
    </details>
  );
}
