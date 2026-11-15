"use client";

import { useState } from "react";

const KINDS = ["", "consumer", "platform", "second_order", "rerating", "event"];

export default function NoticeForm() {
  const [f, setF] = useState({ observation: "", term: "", kind: "", tickers: "" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<{ cardId: number; status: string } | null>(null);
  const [extracted, setExtracted] = useState<Array<{ term: string; tickers: string[]; direction: string | null }> | null>(null);
  const long = f.observation.length > 1500;
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    setResult(null);
    setExtracted(null);
    const tickers = f.tickers.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation: f.observation, term: f.term || undefined, kind: f.kind || null, tickers }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setErrors(j.errors ?? ["failed"]);
    if (j.extracted) return setExtracted(j.extracted);
    setResult({ cardId: j.cardId, status: j.status });
  }

  return (
    <form onSubmit={submit}>
      <label className="field"><span className="field-label">What did you notice? One or two sentences, or paste a whole article or page and the scout pulls the ideas out of it.</span>
        <textarea required rows={3} value={f.observation} onChange={(e) => set("observation", e.target.value)} placeholder="Clients keep asking for X. Everyone at the course has Y." /></label>
      <div className="fields" style={{ marginTop: 10 }}>
        <label className="field"><span className="field-label">Term to measure (optional)</span><input value={f.term} onChange={(e) => set("term", e.target.value)} placeholder="the product, app or theme name" /><span className="field-hint">What the sources should search for. Defaults to your first sentence.</span></label>
        <label className="field"><span className="field-label">Kind (optional)</span>
          <select value={f.kind} onChange={(e) => set("kind", e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{k ? k.replace("_", "-") : "let the scout decide"}</option>)}</select></label>
        <label className="field"><span className="field-label">Tickers you have in mind (optional)</span><input value={f.tickers} onChange={(e) => set("tickers", e.target.value)} placeholder="AAPL, MSFT" /></label>
      </div>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? (long ? "Reading the text for ideas…" : "Researching… this takes a minute or two") : long ? "Find the ideas and research them" : "Research it"}</button>
        <span className="small secondary">The card is logged as human-originated and scored separately. Nothing is traded.</span>
      </div>
      {errors.length > 0 && <ul className="neg small">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {long && !busy && !extracted && <p className="small secondary">Long text ({f.observation.length.toLocaleString("en-US")} characters): the scout will read it for tradeable ideas (up to 12), then research each one in the background. They are logged as yours.</p>}
      {extracted && (
        <div className="small">
          <p><b>{extracted.length} idea(s) found</b>, researching now; cards appear on <a href="/candidates?days=1">Candidates</a> and in the <a href="/inbox">Inbox</a> track record in a few minutes:</p>
          <ul>{extracted.map((x) => <li key={x.term}>{x.term}{x.tickers.length ? ` (${x.tickers.join(", ")})` : ""}{x.direction ? `, ${x.direction}` : ""}</li>)}</ul>
        </div>
      )}
      {result && <p className="small"><b>Card #{result.cardId}</b> logged as <span className={`tag ${result.status}`}>{result.status.replace("_", " ")}</span> — <a href={`/candidates?days=1&card=${result.cardId}#card-${result.cardId}`}>open it</a>.</p>}
    </form>
  );
}
