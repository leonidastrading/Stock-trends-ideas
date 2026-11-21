"use client";

import { useRef, useState } from "react";
import { ACCEPT, MAX_IMAGES, readFiles, type Step } from "@/lib/files/read-files";

/** Paste, pick, drop or paste-in files for the scout to read for rumors: text, PDFs, images, Office files and zips. */
export default function RumorDrop() {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const add = (list: FileList | File[] | null) => { if (list?.length) setFiles((old) => [...old, ...Array.from(list)]); };

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !files.length) return;
    setBusy(true); setMsg(null);
    try {
      // Open zips, read every file (text and Office here, PDFs here or on the server, images by the model).
      const parts: Array<{ name: string; text: string }> = [];
      if (text.trim()) parts.push({ name: "pasted text", text });
      parts.push(...(await readFiles(files, setSteps)));
      if (!parts.some((p) => p.text.trim())) throw new Error("nothing readable in what you sent");

      // 3. Send the pieces as one document.
      const label = source.trim() || (files.length ? `${files[0].name}${files.length > 1 ? ` and ${files.length - 1} more` : ""}` : "");
      const res = await fetch("/api/rumors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts, ...(label ? { source: label.slice(0, 200) } : {}) }) });
      const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
      if (!res.ok || !j.ok) throw new Error((j.errors ?? ["failed"]).join("; "));
      setMsg({ text: `Reading "${j.reading}" (${Number(j.chars).toLocaleString("en-US")} characters from ${parts.length} piece${parts.length === 1 ? "" : "s"}). Rumors appear below in a minute or two; refresh then.`, bad: false });
      setText(""); setFiles([]); setSource("");
      if (input.current) input.current.value = "";
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={send}
      className={`card section rumor-drop${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); add(pasted); } }}
        rows={5}
        placeholder="Paste a thread, an article or a whole page dump here, or drop files (zip, PDF, images, Word, text, JSON…)"
        disabled={busy}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      {files.length > 0 && (
        <div className="small" style={{ margin: "6px 0" }}>
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="tag" style={{ marginRight: 6 }}>
              {f.name} <span className="muted">{f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1e3))} KB`}</span>
              {!busy && <button type="button" className="link-button" aria-label={`remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}> ✕</button>}
            </span>
          ))}
        </div>
      )}
      <div className="toolbar" style={{ margin: "6px 0 0" }}>
        <input ref={input} type="file" multiple accept={ACCEPT} onChange={(e) => { add(e.target.files); e.target.value = ""; }} disabled={busy} />
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Where it's from (optional): r/conspiracy, ZeroHedge…" style={{ width: 280 }} disabled={busy} />
        <button className="primary" type="submit" disabled={busy || (!text.trim() && !files.length)}>{busy ? "Reading…" : "Read for rumors"}</button>
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>Zip archives are opened (folders and nested zips too); images and scanned PDFs are read by the model (up to {MAX_IMAGES} images per upload, each one an AI call); text, Word, PowerPoint and Excel files are read in your browser.</p>
      {steps.length > 0 && (busy || steps.some((s) => s.state === "failed" || s.state === "skipped")) && (
        <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18, maxHeight: 200, overflow: "auto" }}>
          {steps.map((s, i) => (
            <li key={i} className={s.state === "failed" ? "neg" : s.state === "skipped" ? "muted" : ""}>
              {s.state === "done" ? "✓" : s.state === "reading" ? "…" : s.state === "failed" ? "✗" : s.state === "skipped" ? "–" : "·"} {s.name}{s.note ? <span className="muted"> · {s.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={`small ${msg.bad ? "neg" : ""}`}>{msg.text}</p>}
    </form>
  );
}
