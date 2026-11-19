"use client";

import { useState } from "react";

/** Fold one upload's rumors into one per company (and direction). */
export default function CombineButton({ docId, label }: { docId: number; label: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    const res = await fetch("/api/rumors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "combine", docId }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    if (!res.ok || !j.ok) { setBusy(false); return setErr((j.errors ?? ["failed"]).join("; ")); }
    location.reload();
  }
  return <>{" "}<button type="button" className="chip" onClick={go} disabled={busy}>{busy ? "Combining…" : label}</button>{err ? <span className="neg small"> {err}</span> : null}</>;
}
