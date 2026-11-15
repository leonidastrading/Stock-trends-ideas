"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Start an investigation; while one is running, refresh every 15 seconds until it is done. */
export default function InvestigateForm({ running }: { running: boolean }) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [running, router]);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, url: url || undefined }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setMsg({ text: (j.errors ?? ["failed"]).join("; "), bad: true });
    setMsg({ text: "Digging: planning, pulling contracts, lobbying and PAC records, then writing the report. Usually 1-3 minutes; this page refreshes itself.", bad: false });
    setText(""); setUrl("");
    router.refresh();
  }

  return (
    <form onSubmit={go} className="card section">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="Paste a story, a video transcript, a thread, or ask a question (e.g. who profits from the $50B air traffic control rebuild?)" style={{ width: "100%", boxSizing: "border-box" }} disabled={busy} />
      <div className="toolbar" style={{ margin: "6px 0 0" }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="…or a link to an article (optional)" style={{ width: 360 }} disabled={busy} />
        <button className="primary" type="submit" disabled={busy || (!text.trim() && !url.trim())}>{busy ? "Starting…" : "Investigate"}</button>
      </div>
      {msg && <p className={`small ${msg.bad ? "neg" : ""}`}>{msg.text}</p>}
    </form>
  );
}
