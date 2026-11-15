"use client";

import { useState } from "react";
import type { Site, SiteArticle } from "@/lib/scout/store";

const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "never");

/** Settings → Your websites. */
export default function SitesEditor({ sites, articles }: { sites: Site[]; articles: SiteArticle[] }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(key: string, payload: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(key);
    setMsg(null);
    const res = await fetch("/api/sites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(null);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    if (j.message) setMsg(j.message);
    if (payload.action === "add") { setUrl(""); setLabel(""); }
    setTimeout(() => location.reload(), payload.action === "pause" || payload.action === "remove" ? 0 : 2500);
  }

  return (
    <>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); if (url.trim()) act("add", { action: "add", url, label: label || undefined }); }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/news" aria-label="Website address" style={{ width: 320 }} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" aria-label="Name" style={{ width: 180 }} />
        <button className="primary" type="submit" disabled={!!busy || !url.trim()}>{busy === "add" ? "Reading the site…" : "Add website"}</button>
      </form>
      {msg && <p className="small">{msg}</p>}
      {sites.length === 0 ? <p className="small muted">No websites yet. Add a blog, a newsletter archive, a company newsroom or an industry news page.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Website</th><th>Read via</th><th>Last check</th><th>Latest articles</th><th></th></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
                <td><a href={s.url} target="_blank" rel="noreferrer">{s.label}</a>{!s.active && <span className="tag">paused</span>}<div className="small muted">{s.url}</div></td>
                <td className="small">{s.via === "feed" ? "RSS/Atom feed" : s.via === "page" ? "links on the page" : "—"}</td>
                <td className="small"><span className={`tag ${s.status === "ok" ? "ok" : s.status === "down" ? "down" : ""}`}>{s.status ?? "—"}</span> {when(s.checkedAt)}<div className="muted">{s.detail}</div></td>
                <td className="small">
                  {articles.filter((a) => a.siteId === s.id).map((a) => (
                    <div key={a.url}><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> <span className="muted">· {a.outcome ?? "waiting for the next check"}</span></div>
                  ))}
                </td>
                <td className="small" style={{ whiteSpace: "nowrap" }}>
                  <button disabled={!!busy || !s.active} onClick={() => act(`check${s.id}`, { action: "check", id: s.id })}>{busy === `check${s.id}` ? "Reading…" : "Check now"}</button>{" "}
                  <button disabled={!!busy} onClick={() => act(`pause${s.id}`, { action: "pause", id: s.id, active: !s.active })}>{s.active ? "Pause" : "Resume"}</button>{" "}
                  <button disabled={!!busy} onClick={() => act(`remove${s.id}`, { action: "remove", id: s.id }, `Stop following ${s.label}? Cards already written from it stay.`)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
