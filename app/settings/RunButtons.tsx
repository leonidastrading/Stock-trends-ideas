"use client";

import { useState } from "react";

export default function RunButtons() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function run(job: "daily" | "track" | "stories" | "push-test" | "swing-test") {
    if (job === "daily" && !confirm("Run the daily scan now? It measures every watch-list term and may make model calls (within the daily cap).")) return;
    setBusy(job);
    setMsg(null);
    const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(null);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    const r = j.result ?? {};
    const quiet = job === "push-test" || job === "swing-test";
    setMsg(job === "swing-test" ? r.message : job === "push-test" ? "Test notification sent; check your phone." : job === "stories" ? `Story desk done: ${r.headlinesRead ?? 0} headlines, ${r.detected?.length ?? 0} stories, ${r.researched?.length ?? 0} trades researched${r.error ? `; ${r.error}` : ""}.` : job === "daily" ? `Scan done: ${r.measured?.length ?? 0} terms measured, ${r.researched?.length ?? 0} researched${r.stoppedEarly ? `; ${r.stoppedEarly}` : ""}.` : `Tracker done: ${r.barsWritten ?? 0} bars, ${r.entered?.length ?? 0} entered, ${r.exited?.length ?? 0} exited, ${r.open ?? 0} open.`);
    if (!quiet) setTimeout(() => location.reload(), 1500);
  }
  return (
    <div className="actions">
      <button className="primary" disabled={!!busy} onClick={() => run("daily")}>{busy === "daily" ? "Scanning… (a few minutes)" : "Run the daily scan now"}</button>
      <button disabled={!!busy} onClick={() => run("stories")}>{busy === "stories" ? "Reading the news…" : "Scan stories now"}</button>
      <button disabled={!!busy} onClick={() => run("track")}>{busy === "track" ? "Tracking…" : "Run the tracker now"}</button>
      <button disabled={!!busy} onClick={() => run("push-test")}>{busy === "push-test" ? "Sending…" : "Send a test to my phone"}</button>
      <button disabled={!!busy} onClick={() => run("swing-test")}>{busy === "swing-test" ? "Checking…" : "Test the Swing login"}</button>
      <span className="small secondary">The same jobs the cron runs at midday on weekdays and after the close.</span>
      {msg && <div className="small" style={{ width: "100%" }}>{msg}</div>}
    </div>
  );
}
