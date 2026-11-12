"use client";

import { useState } from "react";

export default function RunButtons() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function run(job: "daily" | "track") {
    if (job === "daily" && !confirm("Run the daily scan now? It measures every watch-list term and may make model calls (within the daily cap).")) return;
    setBusy(job);
    setMsg(null);
    const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(null);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    const r = j.result ?? {};
    setMsg(job === "daily" ? `Scan done: ${r.measured?.length ?? 0} terms measured, ${r.researched?.length ?? 0} researched${r.stoppedEarly ? `; ${r.stoppedEarly}` : ""}.` : `Tracker done: ${r.barsWritten ?? 0} bars, ${r.entered?.length ?? 0} entered, ${r.exited?.length ?? 0} exited, ${r.open ?? 0} open.`);
    setTimeout(() => location.reload(), 1500);
  }
  return (
    <div className="actions">
      <button className="primary" disabled={!!busy} onClick={() => run("daily")}>{busy === "daily" ? "Scanning… (a few minutes)" : "Run the daily scan now"}</button>
      <button disabled={!!busy} onClick={() => run("track")}>{busy === "track" ? "Tracking…" : "Run the tracker now"}</button>
      <span className="small secondary">The same jobs the cron runs on weekday mornings and after the close.</span>
      {msg && <div className="small" style={{ width: "100%" }}>{msg}</div>}
    </div>
  );
}
