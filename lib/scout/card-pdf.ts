/**
 * One card as a PDF: the card's own words and numbers laid out on the site's dark background, with a price chart and
 * the paper entry. Real text (it can be selected and searched), drawn by code: no browser, no screenshots.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { KIND_LABEL, type Kind } from "@/config/scout";
import { gateReason } from "./gate-reason";
import { scoreTone } from "./score-tone";
import type { StoredCard, StoredReview, Track } from "./store";
import { thesisFor } from "./thesis";
import { etLabel } from "../time";

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
/** The site's dark theme (app/globals.css). */
export const PDF_COLORS = { bg: "#121211", panel: "#1a1a19", border: "#2f2f2d", grid: "#262624", text: "#f0efec", secondary: "#c3c2b7", muted: "#94938b", accent: "#3987e5", pos: "#4cc38a", warn: "#f5a524", neg: "#f2706b" };
const C = Object.fromEntries(Object.entries(PDF_COLORS).map(([k, v]) => [k, hex(v)])) as Record<keyof typeof PDF_COLORS, RGB>;

const SWAPS: Array<[RegExp, string]> = [[/[→⇒➜]/g, "->"], [/←/g, "<-"], [/≥/g, ">="], [/≤/g, "<="], [/−/g, "-"], [/×/g, "x"], [/≈/g, "~"], [/[    ]/g, " "], [/[​‌‍﻿]/g, ""], [/[✓✔]/g, "yes"], [/[✗✘]/g, "no"], [/↑/g, "up"], [/↓/g, "down"]];

/** Pure: text the PDF's built-in fonts can draw (they cover Western European letters and common punctuation only). */
export function pdfSafe(text: string, font?: PDFFont): string {
  let t = (text ?? "").normalize("NFC");
  for (const [re, to] of SWAPS) t = t.replace(re, to);
  t = t.replace(/\s+/g, " ").trim();
  if (!font) return t;
  const ok = new Set(font.getCharacterSet());
  return [...t].map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : "")).join("").replace(/ {2,}/g, " ").trim();
}

/** Pure: the text broken into lines no wider than `width` (a word longer than a line is cut). */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  for (let word of text.split(" ")) {
    while (!fits(word)) { // one very long word (a URL)
      let n = word.length;
      while (n > 1 && !fits(word.slice(0, n))) n--;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, n));
      word = word.slice(n);
    }
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next; else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

export interface CardPdfInput {
  card: StoredCard; track: Track | null; review: StoredReview | null;
  /** What the company does and the sector's name, when known. */
  about: string | null; sectorLabel: string | null; companyName: string | null;
  /** Where the idea came from, in a word or two. */
  source: string | null;
  /** Daily closes for the chart (oldest first), and the paper result so far, when prices are at hand. */
  bars: Array<{ date: string; c: number }>;
  result: { ret: number; spy: number | null; vsSpy: number | null; closed: boolean } | null;
  siteUrl: string | null; now: Date;
}

const W = 612, H = 792, M = 40, INNER = W - 2 * M;
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "-" : `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(d)}%`);
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The card as PDF bytes. */
export async function cardPdf(input: CardPdfInput): Promise<Uint8Array> {
  const { card: c, track, review } = input;
  const k = c.card;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Card #${c.id}: ${k.title}`));
  doc.setAuthor("Trend scout");
  doc.setCreationDate(input.now);
  const regular = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const pages: PDFPage[] = [];
  let page!: PDFPage, y = 0;
  const newPage = () => {
    page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C.bg });
    pages.push(page);
    y = H - M;
  };
  const need = (h: number) => { if (y - h < M + 22) newPage(); };
  const safe = (s: string, f: PDFFont = regular) => pdfSafe(s, f);
  /** A paragraph at x; returns nothing, moves y down. */
  const para = (text: string, opts: { x?: number; width?: number; size?: number; font?: PDFFont; color?: RGB; lead?: number; gap?: number } = {}) => {
    const { x = M, width = INNER - (x - M), size = 10, font = regular, color = C.text, lead = size * 1.42, gap = 0 } = opts;
    for (const line of wrapText(safe(text, font), font, size, width)) { need(lead); page.drawText(line, { x, y: y - size, size, font, color }); y -= lead; }
    y -= gap;
  };
  const tag = (text: string, x: number, color: RGB): number => {
    const t = safe(text, bold), size = 8.5, w = bold.widthOfTextAtSize(t, size) + 12;
    page.drawRectangle({ x, y: y - 15, width: w, height: 16, color: C.panel, borderColor: color, borderWidth: 0.8 });
    page.drawText(t, { x: x + 6, y: y - 11, size, font: bold, color });
    return x + w + 6;
  };
  const toneColor = (t: "pos" | "warn" | "neg") => C[t];

  newPage();
  // Header: the scout's name, the card number and when it was written.
  page.drawText("TREND SCOUT", { x: M, y: y - 9, size: 9, font: bold, color: C.muted });
  const stamp = safe(`Card #${c.id} · written ${etLabel(c.createdAt)}`);
  page.drawText(stamp, { x: W - M - regular.widthOfTextAtSize(stamp, 9), y: y - 9, size: 9, font: regular, color: C.muted });
  y -= 18;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: C.border });
  y -= 12;

  // Tags: status, kind, where it came from.
  const statusColor = c.status === "promoted" ? C.pos : c.status === "late" ? C.warn : C.muted;
  let tx = tag(c.status.replace("_", " ").toUpperCase(), M, statusColor);
  tx = tag(KIND_LABEL[c.kind as Kind] ?? c.kind, tx, C.secondary);
  if (input.source) tx = tag(input.source, tx, C.accent);
  if (track?.invalidatedAt) tag("INVALIDATED", tx, C.neg);
  y -= 26;

  // The call: a triangle, the side and the ticker, the company.
  const side = c.direction === "long" ? C.pos : C.neg;
  const tri = c.direction === "long" ? "M 0 12 L 7 0 L 14 12 Z" : "M 0 0 L 14 0 L 7 12 Z";
  page.drawSvgPath(tri, { x: M, y: y - 3, color: side });
  const call = `${c.direction.toUpperCase()} ${c.primaryTicker}`;
  page.drawText(call, { x: M + 20, y: y - 15, size: 17, font: bold, color: side });
  const name = safe(input.companyName ?? k.tickers.find((t) => t.symbol === c.primaryTicker)?.company ?? "");
  if (name) page.drawText(name, { x: M + 28 + bold.widthOfTextAtSize(call, 17), y: y - 14, size: 11, font: regular, color: C.secondary });
  y -= 28;
  // No headline: it repeats the thesis below (the card on the site dropped it too).
  const aboutLine = [input.about, input.sectorLabel ? `Sector: ${input.sectorLabel}` : ""].filter(Boolean).join(" · ");
  if (aboutLine) para(aboutLine, { size: 9, color: C.muted, gap: 6 });
  const gate = gateReason(c.status, c.gateNotes);
  if (gate) para(`${c.status === "late" ? "Late" : "Not promoted"}: ${gate}.`, { size: 9, color: C.warn, gap: 6 });

  // The thesis, in a panel with the side's colour down its edge.
  const thesis = safe(thesisFor(c));
  const tLines = wrapText(thesis, regular, 11, INNER - 28);
  const tH = tLines.length * 15.5 + 30;
  need(tH + 8);
  page.drawRectangle({ x: M, y: y - tH, width: INNER, height: tH, color: C.panel, borderColor: C.border, borderWidth: 0.8 });
  page.drawRectangle({ x: M, y: y - tH, width: 3.5, height: tH, color: side });
  page.drawText("THESIS", { x: M + 14, y: y - 16, size: 8, font: bold, color: side });
  tLines.forEach((line, i) => page.drawText(line, { x: M + 14, y: y - 33 - i * 15.5, size: 11, font: regular, color: C.text }));
  y -= tH + 12;

  // Scores, each a small tile.
  const scores: Array<[string, number, "score" | "rank"]> = [["Novelty", Math.round(k.scores.novelty * 10), "score"], ["Materiality", Math.round(k.scores.materiality * 10), "score"], ["Evidence", Math.round(k.scores.breadth_of_evidence * 10), "score"], ["Early", Math.round(k.scores.lateness * 10), "score"], ["Confidence", Math.round(k.confidence), "score"], ["Rank", Math.round(c.rankScore), "rank"]];
  const tileW = (INNER - 5 * 6) / 6;
  need(46);
  scores.forEach(([label, value, kind], i) => {
    const x = M + i * (tileW + 6);
    page.drawRectangle({ x, y: y - 40, width: tileW, height: 40, color: C.panel, borderColor: C.border, borderWidth: 0.8 });
    page.drawText(label.toUpperCase(), { x: x + 8, y: y - 13, size: 6.8, font: bold, color: C.muted });
    page.drawText(`${value}%`, { x: x + 8, y: y - 32, size: 15, font: bold, color: toneColor(scoreTone(value, kind)) });
  });
  y -= 52;

  // The chart: closes, the paper entry as a dashed line, the first and last price.
  const bars = input.bars.filter((b) => b.c > 0);
  if (bars.length >= 10) {
    const ch = 150, x0 = M + 8, x1 = W - M - 52, top = y - 22, bottom = y - ch + 16;
    need(ch + 10);
    page.drawRectangle({ x: M, y: y - ch, width: INNER, height: ch, color: C.panel, borderColor: C.border, borderWidth: 0.8 });
    page.drawText(safe(`${c.primaryTicker} · daily closes, ${day(bars[0].date)} to ${day(bars.at(-1)!.date)}`), { x: M + 8, y: y - 13, size: 8, font: bold, color: C.muted });
    const entry = track?.entryDate && track.entryPrice ? { date: track.entryDate, price: track.entryPrice } : null;
    const values = [...bars.map((b) => b.c), ...(entry ? [entry.price] : [])];
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const px = (i: number) => x0 + (i / (bars.length - 1)) * (x1 - x0), py = (v: number) => bottom + ((v - lo) / span) * (top - bottom);
    for (const g of [0, 0.5, 1]) {
      const v = lo + g * span;
      page.drawLine({ start: { x: x0, y: py(v) }, end: { x: x1, y: py(v) }, thickness: 0.5, color: C.grid });
      page.drawText(`$${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}`, { x: x1 + 6, y: py(v) - 3, size: 7.5, font: regular, color: C.muted });
    }
    for (let i = 1; i < bars.length; i++) page.drawLine({ start: { x: px(i - 1), y: py(bars[i - 1].c) }, end: { x: px(i), y: py(bars[i].c) }, thickness: 1.2, color: C.text });
    if (entry) {
      page.drawLine({ start: { x: x0, y: py(entry.price) }, end: { x: x1, y: py(entry.price) }, thickness: 0.9, color: C.accent, dashArray: [4, 3] });
      const at = bars.findIndex((b) => b.date >= entry.date);
      if (at >= 0) page.drawCircle({ x: px(at), y: py(entry.price), size: 3.2, color: C.accent });
      const label = safe(`entry $${entry.price.toFixed(2)} on ${day(entry.date)}`);
      // On the left, clear of the latest prices; under the line when the line sits at the top of the chart.
      page.drawText(label, { x: x0 + 4, y: py(entry.price) + (py(entry.price) > top - 12 ? -10 : 4), size: 7.5, font: regular, color: C.accent });
    }
    y -= ch + 12;
  }

  // The body: a label and its text, like the card's own list.
  const LABEL_W = 96;
  const row = (label: string, text: string, color: RGB = C.text) => {
    const t = safe(text);
    if (!t) return;
    const lines = wrapText(t, regular, 10, INNER - LABEL_W);
    need(Math.min(lines.length, 3) * 14.2 + 4);
    if (label) page.drawText(safe(label, bold).toUpperCase(), { x: M, y: y - 10, size: 7.5, font: bold, color: C.muted });
    for (const line of lines) { need(14.2); page.drawText(line, { x: M + LABEL_W, y: y - 10, size: 10, font: regular, color }); y -= 14.2; }
    y -= 7;
  };
  row("Observation", k.observation);
  row("Why not priced", k.why_not_priced);
  k.tickers.forEach((t, i) => row(i === 0 ? "Tickers" : "", `${t.symbol}${i === 0 ? " (tracked on paper)" : ""}: ${t.why}${t.revenue_share_pct !== null ? ` About ${t.revenue_share_pct}% of revenue${t.share_is_estimate ? " (estimate)" : ""}.` : ""}`));
  row("Lateness", `${pct(k.lateness.stock_move_30d_pct)} over 30 days, ${pct(k.lateness.stock_move_90d_pct)} over 90 days, ${k.lateness.news_stories_30d} mainstream stories in 30 days${k.lateness.already_obvious ? "; already obvious" : ""}`, k.lateness.already_obvious ? C.warn : C.text);
  row("Catalyst", `${k.catalyst.what} (${k.catalyst.date})`);
  row("Invalidation", k.invalidation);
  row("Time limit", `${k.time_limit_days} days`);
  if (k.expression) row("How to trade it", `${k.expression} (a timing note, not a recommendation; tracked in shares)`);
  if (k.unknowns.length) row("Unknowns", k.unknowns.join("; "));
  if (track) {
    const r = input.result;
    const line = !track.entryDate ? `entry pending: the next open after ${track.cardDate}; exit by ${track.deadlineDate}`
      : `${track.direction === "short" ? "Short" : "Long"} from $${track.entryPrice?.toFixed(2)} on ${track.entryDate}${track.exitDate ? `, closed ${track.exitDate}${track.exitPrice ? ` at $${track.exitPrice.toFixed(2)}` : ""}${track.exitReason ? ` (${track.exitReason.replace(/_/g, " ")})` : ""}` : `, exit by ${track.deadlineDate}`}`;
    row("Paper track", `${r ? `${r.closed ? "Result" : "So far"}: ${pct(r.ret * 100)}${r.spy !== null ? `, SPY ${pct(r.spy * 100)}, ${pct((r.vsSpy ?? 0) * 100)} against SPY` : ""}. ` : ""}${line}${track.excluded ? `. Excluded from scoring: ${track.excluded}` : ""}`, r ? (r.ret >= 0 ? C.pos : C.neg) : C.text);
    if (track.invalidatedAt) row("Invalidated", (track.invalidatedNote ?? "").replace(/^automatic: /, "") || "Marked by you.", C.neg);
  }
  if (review) row("After the catalyst", `${review.verdict.replace(/_/g, " ")}: ${review.summary}`);

  // Evidence.
  if (k.evidence.length) {
    need(40);
    y -= 4;
    page.drawText("EVIDENCE", { x: M, y: y - 9, size: 8.5, font: bold, color: C.muted });
    y -= 16;
    for (const e of k.evidence) {
      const src = safe(e.source, bold);
      const body = safe(`${e.metric}: ${e.value} (${e.change_vs_12m} vs 12 months, as of ${e.as_of})`);
      const srcW = Math.min(bold.widthOfTextAtSize(src, 9.5) + 8, 130);
      const lines = wrapText(body, regular, 9.5, INNER - srcW - 10);
      need(13.5);
      page.drawCircle({ x: M + 3, y: y - 6.5, size: 1.6, color: C.muted });
      page.drawText(wrapText(src, bold, 9.5, 122)[0] ?? "", { x: M + 10, y: y - 9.5, size: 9.5, font: bold, color: C.accent });
      for (const line of lines) { need(13.5); page.drawText(line, { x: M + 10 + srcW, y: y - 9.5, size: 9.5, font: regular, color: C.secondary }); y -= 13.5; }
      y -= 3;
    }
  }

  // Footer on every page.
  pages.forEach((p, i) => {
    const left = safe(`Paper-only research, not advice. Saved ${etLabel(input.now.toISOString())}${input.siteUrl ? ` from ${input.siteUrl.replace(/^https?:\/\//, "")}/cards/${c.id}` : ""}`, italic);
    p.drawLine({ start: { x: M, y: M + 8 }, end: { x: W - M, y: M + 8 }, thickness: 0.6, color: C.border });
    p.drawText(left, { x: M, y: M - 4, size: 7.5, font: italic, color: C.muted });
    const n = `${i + 1} / ${pages.length}`;
    p.drawText(n, { x: W - M - regular.widthOfTextAtSize(n, 7.5), y: M - 4, size: 7.5, font: regular, color: C.muted });
  });
  return doc.save();
}

/** Pure: the file name a card downloads as. */
export const cardPdfName = (c: Pick<StoredCard, "id" | "primaryTicker" | "direction">) => `card-${c.id}-${c.primaryTicker}-${c.direction}.pdf`;
