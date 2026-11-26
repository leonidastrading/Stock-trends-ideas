import { deflateSync, crc32 } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { pagesLabel, splitPdf } from "@/lib/files/split-pdf";

/** A PNG of noise (it does not compress, like a scanned page). */
function noisePng(size: number, seed: number): Uint8Array {
  let x = seed;
  const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16) & 0xff;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let i = 0; i < raw.length; i++) raw[i] = i % (size * 3 + 1) === 0 ? 0 : rnd();
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** A "scan": pages that are each one picture, about `kb` KB a page. */
async function scan(pages: number, px: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) { const img = await doc.embedPng(noisePng(px, i + 1)); doc.addPage([px, px]).drawImage(img, { x: 0, y: 0, width: px, height: px }); }
  return doc.save();
}

describe("splitting a scanned PDF so it can be uploaded and read", () => {
  it("parts of a few pages, each under the size limit, every page once and in order", async () => {
    const pdf = await scan(10, 200); // about 120 KB a page
    expect(pdf.length).toBeGreaterThan(1_000_000);
    const s = await splitPdf(pdf, { maxBytes: 400_000, maxPages: 4, maxParts: 15 });
    expect(s.pages).toBe(10);
    expect(s.tooBig).toEqual([]);
    expect(s.unread).toBe(0);
    expect(s.parts.every((p) => p.bytes.length <= 400_000)).toBe(true);
    // Every page once, in order.
    expect(s.parts.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, k) => p.from + k))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const counts = await Promise.all(s.parts.map(async (p) => (await PDFDocument.load(p.bytes)).getPageCount()));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(counts).toEqual(s.parts.map((p) => p.to - p.from + 1));
  }, 30_000);

  it("stops at the part limit and says how many pages are left; a page too heavy alone is named", async () => {
    const pdf = await scan(6, 200);
    const few = await splitPdf(pdf, { maxBytes: 3_500_000, maxPages: 2, maxParts: 2 });
    expect([few.parts.map(pagesLabel), few.unread]).toEqual([["pages 1-2", "pages 3-4"], 2]);
    const heavy = await splitPdf(pdf, { maxBytes: 50_000, maxPages: 4, maxParts: 15 });
    expect([heavy.parts.length, heavy.tooBig, heavy.unread]).toEqual([0, [1, 2, 3, 4, 5, 6], 0]);
    expect(pagesLabel({ from: 3, to: 3 })).toBe("page 3");
  }, 30_000);

  it("refuses what is not a PDF (the caller falls back)", async () => {
    await expect(splitPdf(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });
});
