/**
 * A PDF's pages drawn as JPEG images, in the browser. A scanned PDF has no text to read, so the model reads its
 * pages; sending them as pictures goes the same way a dropped photo does (which is known to work), where sending
 * pieces of the PDF itself was refused by the model for some files (biotech.pdf, Nov 26 2026: "PDF cannot be empty").
 */
export const PDF_PAGES = { maxPages: 40, maxSide: 1600, quality: 0.8 };

/**
 * Draws the pages one at a time and hands each to `onPage` as base64 JPEG before drawing the next (a long scan is
 * never held in memory whole). Returns the page count and how many were drawn.
 */
export async function eachPdfPage(bytes: Uint8Array, onPage: (jpegBase64: string, page: number, pages: number) => Promise<void>, opts: Partial<typeof PDF_PAGES> = {}): Promise<{ pages: number; drawn: number }> {
  const { maxPages, maxSide, quality } = { ...PDF_PAGES, ...opts };
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes.slice());
  const pages = pdf.numPages;
  let drawn = 0;
  for (let n = 1; n <= Math.min(pages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, maxSide / Math.max(base.width, base.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;
    const jpeg = canvas.toDataURL("image/jpeg", quality).split(",")[1];
    page.cleanup();
    canvas.width = canvas.height = 0;
    await onPage(jpeg, n, pages);
    drawn++;
  }
  return { pages, drawn };
}
