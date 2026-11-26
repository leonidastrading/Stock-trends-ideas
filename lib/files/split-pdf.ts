/**
 * Splitting a PDF into smaller PDFs, a few pages each. A scanned PDF has no text to read, so the model reads its
 * pages; the upload limit is about 4 MB a request and the model's reading of one request is short, so a long scan
 * goes up in parts (biotech.pdf, 12.8 MB, Nov 26 2026: turned away whole with "split it"). Runs in the browser.
 */
export interface PdfPart { bytes: Uint8Array; from: number; to: number }
export interface PdfSplit { parts: PdfPart[]; pages: number; /** Pages too big to send even alone. */ tooBig: number[]; /** Pages left unread because of the part limit. */ unread: number }

export const SPLIT = { maxBytes: 3_500_000, maxPages: 4, maxParts: 15 };

/** The PDF as parts of at most `maxPages` pages and `maxBytes` bytes each, in page order, at most `maxParts` of them. */
export async function splitPdf(bytes: Uint8Array, opts: Partial<typeof SPLIT> = {}): Promise<PdfSplit> {
  const { maxBytes, maxPages, maxParts } = { ...SPLIT, ...opts };
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = src.getPageCount();
  const out: PdfSplit = { parts: [], pages, tooBig: [], unread: 0 };
  const build = async (from: number, n: number) => {
    const doc = await PDFDocument.create();
    for (const p of await doc.copyPages(src, Array.from({ length: n }, (_, k) => from + k))) doc.addPage(p);
    return doc.save();
  };
  let i = 0;
  while (i < pages && out.parts.length < maxParts) {
    let n = Math.min(maxPages, pages - i);
    let part = await build(i, n);
    // Too heavy: fewer pages, down to one.
    while (part.length > maxBytes && n > 1) { n = Math.max(1, Math.floor(n / 2)); part = await build(i, n); }
    if (part.length > maxBytes) { out.tooBig.push(i + 1); i += 1; continue; }
    out.parts.push({ bytes: part, from: i + 1, to: i + n });
    i += n;
  }
  out.unread = pages - i;
  return out;
}

/** Pure: "page 3" or "pages 5-8". */
export const pagesLabel = (p: { from: number; to: number }) => (p.from === p.to ? `page ${p.from}` : `pages ${p.from}-${p.to}`);
