"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ACCEPT, MAX_IMAGES, readFiles, type Step } from "@/lib/files/read-files";

/** What an investigation can take in at most (the API's limit is 300,000 characters). */
const MAX_CHARS = 280_000;

/** Start an investigation from text, a link and/or files; while one is running, refresh every 15 seconds until it is done. */
export default function InvestigateForm({ running }: { running: boolean }) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [running, router]);

  const add = (list: FileList | File[] | null) => { if (list?.length) setFiles((old) => [...old, ...Array.from(list)]); };

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null); setSteps([]);
    try {
      // Files are read in the browser (images and scanned PDFs by the model), then sent as text with the rest.
      let body = text;
      if (files.length) {
        const parts = await readFiles(files, setSteps);
        if (!parts.some((p) => p.text.trim()) && !text.trim() && !url.trim()) throw new Error("nothing readable in the files");
        const docs = parts.filter((p) => p.text.trim()).map((p) => `=== Uploaded file: ${p.name} ===\n${p.text.trim()}`).join("\n\n");
        body = [text.trim(), docs].filter(Boolean).join("\n\n");
        if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n\n[cut: the files held ${body.length.toLocaleString("en-US")} characters; the first ${MAX_CHARS.toLocaleString("en-US")} were sent]`;
      }
      const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, url: url || undefined }) });
      const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
      if (!res.ok || !j.ok) throw new Error((j.errors ?? ["failed"]).join("; "));
      setMsg({ text: "Digging: planning, pulling public records, following leads on the web, then writing the report. Usually 2-5 minutes; this page refreshes itself.", bad: false });
      setText(""); setUrl(""); setFiles([]);
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const ready = !!text.trim() || !!url.trim() || files.length > 0;
  return (
    <form
      onSubmit={go}
      className={`card section rumor-drop${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); add(pasted); } }}
        rows={6}
        placeholder="A ticker or name (CBRS, L3Harris), a question (who profits from the $50B air traffic control rebuild?), or paste a story, transcript or thread. You can also drop files here: a short-seller report PDF, filings, screenshots, a zip."
        style={{ width: "100%", boxSizing: "border-box" }}
        disabled={busy}
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
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="…or a link to an article or report (optional)" style={{ width: 360 }} disabled={busy} />
        <input ref={input} type="file" multiple accept={ACCEPT} onChange={(e) => { add(e.target.files); e.target.value = ""; }} disabled={busy} aria-label="Upload files" />
        <button className="primary" type="submit" disabled={busy || !ready}>{busy ? (steps.some((s) => s.state === "reading") ? "Reading files…" : "Starting…") : "Investigate"}</button>
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>Files: PDFs, Word, PowerPoint, Excel, text, web pages, images and zips. Text is read in your browser; images and scanned PDFs are read by the model (up to {MAX_IMAGES} images, each one an AI call).</p>
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
