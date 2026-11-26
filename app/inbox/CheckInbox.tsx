"use client";

import { useState } from "react";

interface ReadFile { file: string; ideas?: number; sent?: string; error?: string }

/** Inbox: read the files waiting in the GitHub inbox now, instead of at the next hourly call. */
export default function CheckInbox() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: "inbox" }) });
      const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
      if (!res.ok || !j.ok) return setMsg({ text: (j.errors ?? ["failed"]).join("; "), bad: true });
      const r = (j.result ?? {}) as { files?: number; read?: ReadFile[]; error?: string };
      const read = r.read ?? [];
      const text = read.length
        ? `${read.length} new file${read.length === 1 ? "" : "s"} read: ${read.map((x) => `${x.file}: ${x.error ?? `${x.ideas ?? 0} idea${x.ideas === 1 ? "" : "s"}, ${x.sent ?? "sent to research"}`}`).join("; ")}`
        : `Nothing new: ${r.files ?? 0} file${r.files === 1 ? "" : "s"} in the inbox, all read already.`;
      setMsg({ text: `${text}${r.error ? ` · ${r.error}` : ""}`, bad: !!r.error || read.some((x) => x.error) });
      // New files show in the table below once the page is loaded again.
      if (read.length) setTimeout(() => window.location.reload(), 2500);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "failed", bad: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="small">
      <button className="primary" onClick={run} disabled={busy} title="Reads the files waiting in the GitHub inbox now. Each idea is then researched; text and PDF files take a minute or two.">{busy ? "Reading the inbox… up to a few minutes" : "Check for new files now"}</button>
      {msg && <div className={msg.bad ? "warn" : "muted"} style={{ marginTop: 6 }}>{msg.text}</div>}
    </span>
  );
}
