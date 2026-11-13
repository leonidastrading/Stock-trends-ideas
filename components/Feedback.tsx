"use client";

import { useState } from "react";

/** Thumbs up / down with an optional note. Teaches the discovery and story desks what Vadim is interested in. */
export default function Feedback({ target, initial }: { target: string; initial?: { vote: "up" | "down"; note: string | null } | null }) {
  const [vote, setVote] = useState<"up" | "down" | null>(initial?.vote ?? null);
  const [note, setNote] = useState(initial?.note ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function send(v: "up" | "down", withNote = false) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, vote: v, note: withNote ? note : undefined }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    setVote(v);
    setMsg(withNote ? "Saved with note" : "Saved");
    if (withNote) setOpen(false);
  }

  return (
    <div className="feedback">
      <button className={vote === "up" ? "voted" : ""} disabled={busy} title="More like this" onClick={() => send("up")}>👍</button>
      <button className={vote === "down" ? "voted" : ""} disabled={busy} title="Less like this" onClick={() => send("down")}>👎</button>
      <button className="small" disabled={busy} onClick={() => setOpen(!open)}>{open ? "close" : "note"}</button>
      {msg && <span className="small muted">{msg}</span>}
      {open && (
        <div className="inline" style={{ width: "100%", marginTop: 6 }}>
          <input style={{ flex: 1, minWidth: 220 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="what you liked or didn't, what you'd want more of" maxLength={500} />
          <button disabled={busy || !note.trim()} onClick={() => send(vote ?? "up", true)}>Save note{vote ? "" : " (as 👍)"}</button>
        </div>
      )}
    </div>
  );
}
