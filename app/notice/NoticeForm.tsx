"use client";

import LinkedText from "@/components/LinkedText";
import { useState } from "react";

const KINDS = ["", "consumer", "platform", "second_order", "rerating", "event"];

/** Shrink an image in the browser (longest side 1600 px, JPEG): fast to upload and well under the server's size limit. */
async function toJpeg(file: Blob): Promise<{ data: string; preview: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("that file is not an image the browser can open")); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const preview = c.toDataURL("image/jpeg", 0.85);
    return { data: preview.split(",")[1], preview };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function NoticeForm() {
  const [f, setF] = useState({ observation: "", term: "", kind: "", tickers: "" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<{ cardId: number; status: string } | null>(null);
  const [extracted, setExtracted] = useState<Array<{ term: string; tickers: string[]; direction: string | null }> | null>(null);
  const long = f.observation.length > 1500;
  const [img, setImg] = useState<{ preview: string; state: "reading" | "done" | string } | null>(null);

  // An image (picked, pasted or dropped): the scout reads it and fills in the form for you to check.
  async function readImage(file: Blob) {
    setErrors([]);
    setResult(null);
    let shrunk: { data: string; preview: string };
    try { shrunk = await toJpeg(file); } catch (err) { return setErrors([err instanceof Error ? err.message : String(err)]); }
    setImg({ preview: shrunk.preview, state: "reading" });
    const res = await fetch("/api/notice", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mediaType: "image/jpeg", data: shrunk.data, note: f.observation.length < 300 ? f.observation : "" }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    if (!res.ok || !j.ok) return setImg({ preview: shrunk.preview, state: (j.errors ?? ["could not read the image"]).join("; ") });
    setF((old) => ({ ...old, observation: j.observation, term: old.term || j.term || "", tickers: old.tickers || (j.tickers ?? []).join(", ") }));
    setImg({ preview: shrunk.preview, state: "done" });
  }
  function onPaste(e: React.ClipboardEvent) {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (file) { e.preventDefault(); void readImage(file); }
  }
  function onDrop(e: React.DragEvent) {
    const file = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
    if (file) { e.preventDefault(); void readImage(file); }
  }
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
    <form onSubmit={submit} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="notice-image">
        <label className="notice-image-pick">
          <input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) void readImage(file); e.target.value = ""; }} />
          <span>📷 Upload an image</span>
        </label>
        <span className="small secondary">A chart, a screenshot of a post or article, or a photo. Or paste a screenshot (Ctrl/Cmd+V) or drop it here. The scout reads it and fills in the form below for you to check before researching.</span>
        {img && (
          <div className="notice-image-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.preview} alt="Your uploaded image" />
            <span className={`small ${img.state === "done" ? "pos" : img.state === "reading" ? "muted" : "neg"}`}>{img.state === "reading" ? "Reading the image… about 15 seconds" : img.state === "done" ? "Read. Check the text below, then press Research it." : img.state}</span>
            <button type="button" className="link-button small" onClick={() => setImg(null)}>remove</button>
          </div>
        )}
      </div>
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
      {errors.length > 0 && <ul className="neg small">{errors.map((e) => <li key={e}><LinkedText text={e} /></li>)}</ul>}
      {long && !busy && !extracted && <p className="small secondary">Long text ({f.observation.length.toLocaleString("en-US")} characters): the scout will read it for tradeable ideas (up to 12), then research each one in the background. They are logged as yours.</p>}
      {extracted && (
        <div className="small">
          <p><b>{extracted.length} idea(s) found</b>, researching now; cards appear on <a href="/ideas?sort=newest">Ideas</a> and in the <a href="/inbox">Inbox</a> track record in a few minutes:</p>
          <ul>{extracted.map((x) => <li key={x.term}>{x.term}{x.tickers.length ? ` (${x.tickers.join(", ")})` : ""}{x.direction ? `, ${x.direction}` : ""}</li>)}</ul>
        </div>
      )}
      {result && <p className="small"><b>Card #{result.cardId}</b> logged as <span className={`tag ${result.status}`}>{result.status.replace("_", " ")}</span> — <a href={`/cards/${result.cardId}`}>open it</a>.</p>}
    </form>
  );
}
