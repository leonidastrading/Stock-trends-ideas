/**
 * Reading uploaded files in the browser, shared by the Rumors and Investigate uploads: zips opened (nested too),
 * text and Office files read here, PDFs read here (scanned ones on the server, where the model reads the pages, a
 * long or heavy scan a few pages at a time),
 * images shrunk to JPEG and read by the model. Each file reports its progress as a step.
 */
import { decodeText, kindOf, looksBinary, officeText, unzipFiles } from "./unpack";

/** The most images read by the model per upload (each one is a model call). */
export const MAX_IMAGES = 30;
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

/** A PDF's text: read in the browser when it has a text layer, else on the server (scanned pages go to the model, a long or heavy scan in parts). */
async function pdfText(name: string, bytes: Uint8Array, onNote: (note: string) => void = () => undefined): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: true });
    const t = Array.isArray(text) ? text.join("\n") : text;
    if (t.replace(/\s+/g, "").length >= 50) return t;
  } catch { /* fall back to the server */ }
  const whole = () => {
    const form = new FormData();
    form.set("file", new Blob([bytes.slice()], { type: "application/pdf" }), name);
    return readOnServer({ body: form });
  };
  // A scan: split it, so a heavy file fits the upload limit and a long one is read a few pages at a time.
  const { pagesLabel, splitPdf } = await import("./split-pdf");
  const split = await splitPdf(bytes).catch(() => null);
  if (!split) {
    if (bytes.length > MAX_SERVER_PDF) throw new Error(`scanned PDF over ${MAX_SERVER_PDF / 1e6} MB that could not be split (protected or damaged?): upload the pages as images`);
    return whole();
  }
  if (split.parts.length <= 1 && bytes.length <= MAX_SERVER_PDF && !split.unread) return whole();
  if (!split.parts.length) throw new Error("scanned PDF whose pages are each over the upload limit: upload the pages as smaller images");
  const texts: string[] = [];
  let failed = 0;
  for (const [k, part] of split.parts.entries()) {
    onNote(`scanned: the model is reading ${pagesLabel(part)} of ${split.pages} (part ${k + 1} of ${split.parts.length})`);
    const form = new FormData();
    form.set("file", new Blob([part.bytes.slice()], { type: "application/pdf" }), name);
    form.set("part", `${pagesLabel(part)} of ${split.pages}`);
    try { texts.push(`[${name}, ${pagesLabel(part)}]\n${await readOnServer({ body: form })}`); } catch (err) { failed++; if (!texts.length && k === split.parts.length - 1) throw err; }
  }
  const left = [split.unread ? `the last ${split.unread} pages were not read (only the first ${split.parts.at(-1)!.to} are)` : "", split.tooBig.length ? `page${split.tooBig.length === 1 ? "" : "s"} ${split.tooBig.join(", ")} too large to send` : "", failed ? `${failed} part${failed === 1 ? "" : "s"} could not be read` : ""].filter(Boolean);
  if (left.length) texts.push(`[${name}: ${left.join("; ")}]`);
  return texts.join("\n\n");
}

export type Step = { name: string; state: "waiting" | "reading" | "done" | "skipped" | "failed"; note?: string };

/** Every readable piece of the files, with a step per file (zips listed file by file). */
export async function readFiles(files: File[], onSteps: (steps: Step[]) => void): Promise<Array<{ name: string; text: string }>> {
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
  const all: Step[] = [...entries.map((x) => ({ name: x.name, state: "waiting" as const })), ...log];
  const update = (i: number, s: Partial<Step>) => { all[i] = { ...all[i], ...s }; onSteps([...all]); };
  onSteps([...all]);
  const parts: Array<{ name: string; text: string }> = [];
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
        parts.push({ name: x.name, text: await pdfText(x.name, x.bytes, (note) => update(i, { state: "reading", note })) });
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
  return parts;
}

export const ACCEPT = ".zip,.pdf,.txt,.md,.html,.htm,.json,.jsonl,.ndjson,.csv,.tsv,.xml,.eml,.rtf,.docx,.pptx,.xlsx,.odt,image/*";
