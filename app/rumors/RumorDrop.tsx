"use client";

import { useState } from "react";

/** Paste or upload a dump for the scout to read for rumors. */
export default function RumorDrop() {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !file) return;
    setBusy(true); setMsg(null);
    const form = new FormData();
    if (file) form.set("file", file);
    else form.set("text", text);
    form.set("source", source);
    const res = await fetch("/api/rumors", { method: "POST", body: form });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setMsg({ text: (j.errors ?? ["failed"]).join("; "), bad: true });
    setMsg({ text: `Reading "${j.reading}" (${Number(j.chars).toLocaleString("en-US")} characters). Rumors appear below in a minute or two; refresh then.`, bad: false });
    setText(""); setFile(null); setSource("");
    const el = document.getElementById("rumor-file") as HTMLInputElement | null;
    if (el) el.value = "";
  }

  return (
    <form onSubmit={send} className="card section">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Paste a thread, an article or a whole page dump here…" disabled={busy || !!file} style={{ width: "100%", boxSizing: "border-box" }} />
      <div className="toolbar" style={{ margin: "6px 0 0" }}>
        <input id="rumor-file" type="file" accept=".txt,.md,.html,.htm,.pdf,.json,.jsonl,.ndjson,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Where it's from (optional): r/conspiracy, ZeroHedge…" style={{ width: 280 }} disabled={busy} />
        <button className="primary" type="submit" disabled={busy || (!text.trim() && !file)}>{busy ? "Sending…" : "Read for rumors"}</button>
      </div>
      {msg && <p className={`small ${msg.bad ? "neg" : ""}`}>{msg.text}</p>}
    </form>
  );
}
