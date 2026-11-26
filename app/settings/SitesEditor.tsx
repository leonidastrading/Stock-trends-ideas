"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Site, SiteArticle } from "@/lib/scout/store";
import { etLabelAgo } from "@/lib/time";

const when = (iso: string | null) => (iso ? etLabelAgo(iso) : "never");

/** Settings → Your websites. */
export default function SitesEditor({ sites, articles, quiet = {} }: { sites: Site[]; articles: SiteArticle[]; /** Sites read for two weeks with no idea from them: site id → articles read. */ quiet?: Record<number, number> }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"ideas" | "rumors">("ideas");
  const [readNow, setReadNow] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /** Result of the last action on one site, shown in that site's row. */
  const [rowMsg, setRowMsg] = useState<Record<number, { text: string; bad: boolean }>>({});
  const router = useRouter();

  async function act(key: string, payload: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    const id = typeof payload.id === "number" ? payload.id : null;
    const say = (text: string, bad = false) => (id === null ? setMsg(text) : setRowMsg((m) => ({ ...m, [id]: { text, bad } })));
    setBusy(key);
    if (id === null) setMsg(null);
    else say(payload.action === "check" ? "Reading this site now… (up to a minute)" : "…");
    const res = await fetch("/api/sites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(null);
    if (!res.ok || !j.ok) return say((j.errors ?? ["failed"]).join("; "), true);
    if (j.message) say(j.message);
    else if (id !== null) setRowMsg((m) => { const n = { ...m }; delete n[id]; return n; });
    if (payload.action === "add") { setUrl(""); setLabel(""); }
    // Re-read the table (last check, latest articles) without losing the messages.
    router.refresh();
  }

  async function checkAll() {
    for (const s of sites.filter((x) => x.active)) await act(`check${s.id}`, { action: "check", id: s.id });
  }

  return (
    <>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); if (url.trim()) act("add", { action: "add", url, label: label || undefined, kind, readLatest: readNow }); }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/news" aria-label="Website address" style={{ width: 320 }} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" aria-label="Name" style={{ width: 180 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value as "ideas" | "rumors")} aria-label="Use for">
          <option value="ideas">for trade ideas</option>
          <option value="rumors">for the Rumors tab</option>
        </select>
        <label className="small" title="Read the newest 10 articles or PDF reports right away (digests for research, Dots, chat and cards; trade ideas to research or claims to Rumors)"><input type="checkbox" checked={readNow} onChange={(e) => setReadNow(e.target.checked)} /> read the latest 10 now</label>
        <button className="primary" type="submit" disabled={!!busy || !url.trim()}>{busy === "add" ? "Reading the site…" : "Add website"}</button>
        {sites.some((s) => s.active) && <button type="button" disabled={!!busy} onClick={checkAll} title="Reads each active site in turn; results show in each row">Check all sites now</button>}
      </form>
      {msg && <p className="small">{msg}</p>}
      {sites.length === 0 ? <p className="small muted">No websites yet. Add a blog, a newsletter archive, a company newsroom or an industry news page.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Website</th><th>Read via</th><th>Last check</th><th>Latest articles</th></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
                <td style={{ minWidth: 220 }}>
                  <a href={s.url} target="_blank" rel="noreferrer">{s.label}</a> <span className={`tag ${s.kind === "rumors" ? "late" : ""}`}>{s.kind === "rumors" ? "rumors" : "ideas"}</span>{!s.active && <span className="tag">paused</span>}{quiet[s.id] ? <span className="tag warn" title="Its articles have been read for two weeks and none led to an idea. Consider removing it, or pausing it.">no idea in 14 days ({quiet[s.id]} read)</span> : null}<div className="small muted">{s.url}</div>
                  <div className="small" style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="small" disabled={busy === `check${s.id}` || !s.active} title={`Read ${s.label} now for new articles (this site only)`} onClick={() => act(`check${s.id}`, { action: "check", id: s.id })}>{busy === `check${s.id}` ? "Reading…" : "Check this site"}</button>
                    <button className="small" disabled={busy === `latest${s.id}`} title={`Read the newest 10 articles or PDF reports on ${s.label} now, including ones already there: kept for research, Dots, chat and cards; ${s.kind === "rumors" ? "claims to the Rumors tab" : "trade ideas to research"}`} onClick={() => act(`latest${s.id}`, { action: "latest", id: s.id })}>{busy === `latest${s.id}` ? "Starting…" : "Read latest 10"}</button>
                    <button className="small" disabled={busy === `kind${s.id}`} title={s.kind === "rumors" ? "New articles will be read for trade ideas" : "New articles will go to the Rumors tab instead of research"} onClick={() => act(`kind${s.id}`, { action: "kind", id: s.id, kind: s.kind === "rumors" ? "ideas" : "rumors" })}>{s.kind === "rumors" ? "Use for ideas" : "Use for rumors"}</button>
                    <button className="small" disabled={busy === `pause${s.id}`} onClick={() => act(`pause${s.id}`, { action: "pause", id: s.id, active: !s.active })}>{s.active ? "Pause" : "Resume"}</button>
                    <button className="small" disabled={busy === `remove${s.id}`} onClick={() => act(`remove${s.id}`, { action: "remove", id: s.id }, `Stop following ${s.label}? Cards already written from it stay.`)}>Remove</button>
                  </div>
                  {rowMsg[s.id] && <div className={`small ${rowMsg[s.id].bad ? "neg" : ""}`} style={{ marginTop: 4 }}>{rowMsg[s.id].text}</div>}
                </td>
                <td className="small">{s.via === "feed" ? "RSS/Atom feed" : s.via === "page" ? "links on the page" : "—"}</td>
                <td className="small"><span className={`tag ${s.status === "ok" ? "ok" : s.status === "down" ? "down" : ""}`}>{s.status ?? "—"}</span> {when(s.checkedAt)}<div className="muted">{s.detail}</div></td>
                <td className="small">
                  {articles.filter((a) => a.siteId === s.id).map((a) => (
                    <div key={a.url}><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> <span className="muted">· {a.outcome ?? "waiting for the next check"}</span></div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
