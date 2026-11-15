"use client";

import { useState } from "react";

export default function RefreshDigest() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: "inbox-digest" }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    setMsg(j.result?.message ?? "done");
    window.location.reload();
  }
  return (
    <span className="small">
      <button onClick={run} disabled={busy}>{busy ? "Summarising… about a minute" : "Refresh summary"}</button>
      {msg && <span className="muted" style={{ marginLeft: 6 }}>{msg}</span>}
    </span>
  );
}
