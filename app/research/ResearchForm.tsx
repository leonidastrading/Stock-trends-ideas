"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ACCEPT, readFiles, type Step } from "@/lib/files/read-files";
import { joinParts } from "@/lib/files/unpack";
import { RESEARCH_DOC, docLabel, withDocument } from "@/lib/scout/research-doc";
import { typedTickers, type OnFile } from "@/lib/scout/cards-on-file";

/** Research a stock, an idea or an uploaded document. It runs in the background; results appear in the list below. */
export default function ResearchForm() {
  const [idea, setIdea] = useState("");
  const [tickers, setTickers] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [over, setOver] = useState(false);
  const [state, setState] = useState<"idle" | "reading" | "busy" | { ok: boolean; msg: string }>("idle");
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const working = state === "reading" || state === "busy";
  // The scout's existing cards on what is typed, a beat after the last key: so you see them before researching again.
  const [onFile, setOnFile] = useState<{ for: string; cards: Record<string, OnFile[]> } | null>(null);
  const typed = typedTickers(tickers).join(",");
  useEffect(() => {
    if (!typed) { setOnFile(null); return; }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/lookup?cards=${encodeURIComponent(typed)}`).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (j?.ok) setOnFile({ for: typed, cards: j.cards ?? {} });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const add = (list: FileList | File[] | null) => { if (list?.length) setFiles((old) => [...old, ...Array.from(list)]); };

  async function go(e: React.FormEvent) {
    e.preventDefault();
    const syms = typedTickers(tickers);
    const asked = idea.trim() || (syms.length ? `Research ${syms.join(", ")}: is there a trade here now? What is moving it, what is already priced in, and what is the next catalyst?` : "");
    if (asked.length < 5 && !files.length) return setState({ ok: false, msg: "Type a ticker or an idea, or add a document." });

    // A document: read it here (zips opened, PDFs, Word, text; images and scanned pages by the model).
    let doc = "", name = "";
    if (files.length) {
      setState("reading");
      try {
        doc = joinParts(await readFiles(files, setSteps), 190_000);
      } catch (err) {
        return setState({ ok: false, msg: err instanceof Error ? err.message : String(err) });
      }
      if (!doc.trim()) return setState({ ok: false, msg: "Nothing readable in the document." });
      name = docLabel(files.map((f) => f.name));
    }

    setState("busy");
    const title = (idea.trim() ? idea.trim().split(/[.!?\n]/)[0] : syms.length ? `Research ${syms.join(", ")}` : name).slice(0, 80);
    // With a ticker or an idea, the document is material for that one research; alone, its ideas are pulled out and each is researched.
    const body = doc && asked
      ? { observation: withDocument(asked, name, doc), tickers: syms, direct: true, background: true, term: title }
      : doc
        ? { observation: doc, background: true, term: title, doc: name }
        : { observation: asked, tickers: syms, direct: true, background: true, term: title };
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok || !j.ok) return setState({ ok: false, msg: (j.errors ?? [res ? `could not start (HTTP ${res.status})` : "could not start"]).join("; ") });
    setIdea(""); setTickers(""); setFiles([]); setSteps([]);
    if (input.current) input.current.value = "";
    const found: Array<{ term: string; tickers: string[] }> = j.extracted ?? [];
    setState({
      ok: true,
      msg: found.length
        ? `Found ${j.found > found.length ? `${j.found} ideas in ${name}; researching the first ${found.length}` : `${found.length} idea${found.length === 1 ? "" : "s"} in ${name}; researching ${found.length === 1 ? "it" : "each"}`}: ${found.map((f) => (f.tickers.length ? `${f.tickers[0]} (${f.term})` : f.term)).join("; ")}.${j.cut ? " The document is long: only its first 60,000 characters were read." : ""} Results appear below over the next few minutes.`
        : `Started${doc ? `, with ${name} attached${doc.length > RESEARCH_DOC.attachChars ? ` (its first ${RESEARCH_DOC.attachChars.toLocaleString("en-US")} characters)` : ""}` : ""}. It takes a minute or two; the result appears below.`,
    });
    router.refresh();
    // Ideas from a document are logged as each one starts: look again shortly.
    if (found.length) setTimeout(() => router.refresh(), 6000);
  }

  return (
    <form
      onSubmit={go}
      className={`research-form rumor-drop${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      <div className="toolbar">
        <input value={tickers} onChange={(e) => setTickers(e.target.value)} placeholder="Ticker(s), e.g. ORCL or ORCL CRWV" aria-label="Tickers" style={{ width: 240, textTransform: "uppercase" }} disabled={working} />
      </div>
      {onFile && onFile.for === typed && (
        <div className="small" style={{ marginTop: 8 }}>
          {typed.split(",").map((sym) => {
            const cards = onFile.cards[sym] ?? [];
            return (
              <div key={sym} style={{ marginBottom: 4 }}>
                {cards.length === 0 ? <span className="muted">No cards on <b>{sym}</b> yet.</span> : (
                  <>
                    <span className="secondary">Already on file for <b>{sym}</b> ({cards.length}):</span>
                    <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
                      {cards.slice(0, 6).map((c) => (
                        <li key={c.id}>
                          <a href={`/cards/${c.id}`}>card #{c.id}</a> <span className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲ long" : "▼ short"}</span> <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span> {c.title} <span className="muted">· {new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}{c.primary ? "" : ` · ${sym} is one of its other tickers`}</span>
                        </li>
                      ))}
                      {cards.length > 6 && <li className="muted">and {cards.length - 6} older</li>}
                    </ul>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <textarea value={idea} onChange={(e) => setIdea(e.target.value)} onPaste={(e) => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); add(pasted); } }} rows={3} placeholder="The idea, in a sentence or two (optional with a ticker or a document): what you noticed, and what you think it means." aria-label="Idea" style={{ width: "100%", marginTop: 8 }} disabled={working} />
      {files.length > 0 && (
        <div className="small" style={{ margin: "6px 0" }}>
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="tag" style={{ marginRight: 6 }}>
              {f.name} <span className="muted">{f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1e3))} KB`}</span>
              {!working && <button type="button" className="link-button" aria-label={`remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}> ✕</button>}
            </span>
          ))}
        </div>
      )}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <label className="small secondary">Document: <input ref={input} type="file" multiple accept={ACCEPT} onChange={(e) => { add(e.target.files); e.target.value = ""; }} disabled={working} /></label>
        <button className="primary" type="submit" disabled={working}>{state === "reading" ? "Reading the document…" : state === "busy" ? (files.length && !idea.trim() && !tickers.trim() ? "Finding the ideas in it…" : "Starting…") : "Research it"}</button>
        {typeof state === "object" && <span className={`small ${state.ok ? "pos" : "neg"}`}>{state.msg}</span>}
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>Upload, drop or paste a document (PDF, Word, PowerPoint, Excel, text, images, a zip of them). With a ticker or an idea, it is read as material for that one research. On its own, the scout pulls out up to 6 ideas and researches each.</p>
      {steps.length > 0 && (working || steps.some((s) => s.state === "failed" || s.state === "skipped")) && (
        <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18, maxHeight: 160, overflow: "auto" }}>
          {steps.map((s, i) => (
            <li key={i} className={s.state === "failed" ? "neg" : s.state === "skipped" ? "muted" : ""}>
              {s.state === "done" ? "✓" : s.state === "reading" ? "…" : s.state === "failed" ? "✗" : s.state === "skipped" ? "–" : "·"} {s.name}{s.note ? <span className="muted"> · {s.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** While anything is still running, refresh the list every 15 seconds. */
export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [running, router]);
  return null;
}
