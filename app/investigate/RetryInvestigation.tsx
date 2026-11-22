"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Run a failed investigation again (same input). */
export default function RetryInvestigation({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="small">
      <button type="button" className="chip" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", id }) });
        const j = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok || !j.ok) setErr((j.errors ?? [`HTTP ${res.status}`]).join("; ")); else router.refresh();
      }}>{busy ? "Starting…" : "Run again"}</button>
      {err && <span className="neg"> {err}</span>}
    </span>
  );
}
