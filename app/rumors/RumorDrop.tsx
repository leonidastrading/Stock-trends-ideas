"use client";

import { useRef, useState } from "react";
import { decodeText, kindOf, looksBinary, officeText, unzipFiles } from "@/lib/files/unpack";

/** The most images read by the model per upload (each one is a model call). */
const MAX_IMAGES = 30;
/** Vercel refuses request bodies over 4.5 MB. */
const MAX_SERVER_PDF = 4_000_000;

/** An image the browser can open, as a JPEG at most 1600 px on its longest side (base64). */
async function toJpeg(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("the browser cannot open this image (HEIC or TIFF? export it as JPEG)")); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readOnServer(init: RequestInit): Promise<string> {
  const res = await fetch("/api/rumors", { method: "PUT", ...init });
  const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
  if (!res.ok || !j.ok) throw new Error((j.errors ?? ["could not read it"]).join("; "));
  return String(j.text ?? "");
}

/** A PDF's text: read in the browser when it has a text layer, else on the server (scanned pages go to the model). */
async function pdfText(name: string, bytes: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: true });
    const t = Array.isArray(text) ? text.join("\n") : text;
    if (t.replace(/\s+/g, "").length >= 50) return t;
  } catch { /* fall back to the server */ }
  if (bytes.length > MAX_SERVER_PDF) throw new Error(`scanned PDF over ${MAX_SERVER_PDF / 1e6} MB: split it or upload the pages as images`);
  const form = new FormData();
  form.set("file", new Blob([bytes.slice()], { type: "application/pdf" }), name);
  return readOnServer({ body: form });
}

type Step = { name: string; state: "waiting" | "reading" | "done" | "skipped" | "failed"; note?: string };

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
      // 1. Open zips and list every file inside.
      const entries: Array<{ name: string; bytes: Uint8Array; type: string }> = [];
      const log: Step[] = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (kindOf(f.name, f.type) === "zip") {
          const { files: inside, skipped } = unzipFiles(bytes, `${f.name}/`);
          entries.push(...inside.map((x) => ({ ...x, type: "" })));
          log.push(...skipped.map((s) => ({ name: s, state: "skipped" as const })));
        } else entries.push({ name: f.name, bytes, type: f.type });
      }
      const order: Step[] = entries.map((x) => ({ name: x.name, state: "waiting" }));
      const all = [...order, ...log];
      const update = (i: number, s: Partial<Step>) => { all[i] = { ...all[i], ...s }; setSteps([...all]); };
      setSteps([...all]);

      // 2. Read each one: text and Office files here, PDFs here or on the server, images by the model.
      const parts: Array<{ name: string; text: string }> = [];
      if (text.trim()) parts.push({ name: "pasted text", text });
      let images = 0;
      for (const [i, x] of entries.entries()) {
        const kind = kindOf(x.name, x.type);
        try {
          if (kind === "image") {
            if (++images > MAX_IMAGES) { update(i, { state: "skipped", note: `over ${MAX_IMAGES} images in one upload` }); continue; }
            update(i, { state: "reading", note: "the model is reading the image" });
            const t = await readOnServer({ headers: { "content-type": "application/json" }, body: JSON.stringify({ mediaType: "image/jpeg", data: await toJpeg(new Blob([x.bytes.slice()], { type: x.type || "image/*" })) }) });
            parts.push({ name: x.name, text: t });
          } else if (kind === "pdf") {
            update(i, { state: "reading" });
            parts.push({ name: x.name, text: await pdfText(x.name, x.bytes) });
          } else if (kind === "office") {
            const t = officeText(x.name, x.bytes);
            if (!t) { update(i, { state: "skipped", note: "no text in it" }); continue; }
            parts.push({ name: x.name, text: t });
          } else if (kind === "text" && !looksBinary(x.bytes)) {
            parts.push({ name: x.name, text: decodeText(x.bytes) });
          } else { update(i, { state: "skipped", note: "not a file type the scout can read" }); continue; }
          update(i, { state: "done", note: `${parts[parts.length - 1].text.length.toLocaleString("en-US")} characters` });
        } catch (err) {
          update(i, { state: "failed", note: err instanceof Error ? err.message : String(err) });
        }
      }
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
        <input ref={input} type="file" multiple accept=".zip,.pdf,.txt,.md,.html,.htm,.json,.jsonl,.ndjson,.csv,.tsv,.xml,.eml,.rtf,.docx,.pptx,.xlsx,.odt,image/*" onChange={(e) => { add(e.target.files); e.target.value = ""; }} disabled={busy} />
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
