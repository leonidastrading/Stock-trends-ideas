"use client";

import { useState } from "react";

export function AddForm() {
  const [f, setF] = useState({ term: "", kind: "consumer", tickers: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/watchlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", term: f.term, kind: f.kind, tickers: f.tickers.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean) }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setErr((j.errors ?? ["failed"]).join("; "));
    location.reload();
  }
  return (
    <form onSubmit={submit} className="inline">
      <input required value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} placeholder="term, brand, app or theme" style={{ minWidth: 240 }} />
      <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
        <option value="consumer">consumer</option><option value="platform">platform</option><option value="second_order">second-order</option><option value="rerating">re-rating</option><option value="event">event</option>
      </select>
      <input value={f.tickers} onChange={(e) => setF({ ...f, tickers: e.target.value })} placeholder="tickers (optional)" />
      <button className="primary" type="submit" disabled={busy}>Add</button>
      {err && <span className="small neg">{err}</span>}
    </form>
  );
}

export function StatusButton({ id, action, label }: { id: number; action: "approve" | "retire" | "reactivate"; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} onClick={async () => {
      setBusy(true);
      await fetch("/api/watchlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id }) });
      location.reload();
    }}>{label}</button>
  );
}
