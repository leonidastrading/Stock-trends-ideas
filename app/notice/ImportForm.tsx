"use client";

import { useState } from "react";

/** Paste the machine-readable block from the daily stream file. */
export default function ImportForm() {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, label }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    setMsg(res.ok && j.ok ? `Researching ${j.accepted} ideas in the background; they appear on Candidates in a few minutes.${j.skipped?.length ? ` Skipped: ${j.skipped.join("; ")}` : ""}` : (j.errors ?? ["failed"]).join("; "));
  }
  return (
    <form onSubmit={submit}>
      <div className="fields">
        <label className="field"><span className="field-label">File date</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="2026-11-13" /></label>
      </div>
      <label className="field"><span className="field-label">Machine-readable block (the JSON at the end of the file)</span>
        <textarea required rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder='[ {"observation": "...", "term": "...", "kind": "event", "tickers": ["ZM"], ...} ]' /></label>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? "Sending…" : "Import ideas"}</button>
        <span className="small secondary">Each idea is researched and gated like your own; host and agent ideas are scored on their own lines.</span>
      </div>
      {msg && <p className="small">{msg}</p>}
    </form>
  );
}
