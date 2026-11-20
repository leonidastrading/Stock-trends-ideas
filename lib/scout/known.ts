/**
 * What the scout's other pages already know about a stock, for research and the chat: your investigations, earlier
 * cards (with their one-line theses and results), themes, Dots ideas, rumors and how their checks came out, lawsuits
 * (class actions, ITC patent cases), FDA dates and trial readouts, the filing watch, insider buying, Congress trades
 * and your favourites. Everything is dated and labelled with where it came from; research is told it is background
 * to weigh and check, not news. Each section is bounded, and a failing source leaves its section out.
 *
 * Changing what this reads changes research input: bump KNOWN_REVISION (it is part of the scout's version).
 */
import * as store from "./store";
import { addDays, toEt } from "../time";

/**
 * 1 = investigations, cards, themes, dots, rumors, court, pharma, filing watch, insiders, Congress, favourites;
 * 2 = research is also told which page an idea was sent from (Dots, Court, Pharma, News, Filings).
 */
export const KNOWN_REVISION = 2;

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const on = (sym: string, xs: string[] | undefined | null) => (xs ?? []).map((x) => x.toUpperCase()).includes(sym);

export interface KnownSection { title: string; lines: string[] }

/** Pure: the sections as text, under a cap. */
export function knownText(symbols: string[], sections: KnownSection[], max = 6000): string | null {
  const kept = sections.filter((s) => s.lines.length);
  if (!kept.length) return null;
  let out = `WHAT THE SCOUT'S OTHER PAGES ALREADY KNOW about ${symbols.join(", ")} (the scout's own earlier work and the user's investigations; dated background to weigh and check against the evidence, not news and not proof):`;
  for (const s of kept) {
    const block = `\n- ${s.title}:\n${s.lines.map((l) => `  · ${l}`).join("\n")}`;
    if (out.length + block.length > max) { out += `\n- (more left out: ${kept.slice(kept.indexOf(s)).map((x) => x.title).join(", ")})`; break; }
    out += block;
  }
  return out;
}

/** Everything the other pages know about these stocks (up to 3), as research and chat background. */
export async function whatTheScoutKnows(symbols: string[], now = new Date(), max = 6000): Promise<string | null> {
  const syms = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 3);
  if (!syms.length) return null;
  const today = toEt(now).date;
  const safe = async <T,>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };
  const [invs, cards, tracks, themes, dots, rumors, checks, classes, itc, fda, trials, watch, buys, congress, favs] = await Promise.all([
    safe(() => import("./investigate").then(({ listInvestigations }) => listInvestigations(40)), []),
    safe(() => store.cardsSince(120), []),
    safe(() => store.allTracks(), []),
    safe(() => import("./themes").then(({ themeRuns }) => themeRuns(15)), []),
    safe(() => import("./dots").then(({ dotsRuns }) => dotsRuns(15)), []),
    safe(() => import("./rumors").then(({ rumorsSince }) => rumorsSince(45, 400)), []),
    safe(() => import("./rumor-check").then(({ latestChecks }) => latestChecks()), new Map()),
    safe(() => store.cacheGet<import("../sources/court").ClassActionCase[]>("court:class-actions"), null),
    safe(() => store.cacheGet<import("../sources/court").ItcNotice[]>("court:itc"), null),
    safe(() => store.cacheGet<import("../sources/pharma").FdaEvent[]>("pharma:fda"), null),
    safe(() => store.cacheGet<import("../sources/pharma").TrialReadout[]>("pharma:trials"), null),
    safe(() => import("./filing-watch").then(({ latestFilingWatch }) => latestFilingWatch(syms)), new Map()),
    safe(() => store.insiderBuysSince(addDays(today, -90)), []),
    safe(() => store.congressTradesSince(addDays(today, -60)), []),
    safe(() => store.favorites(), []),
  ]);
  const { thesisFor } = await import("./thesis");
  const favSet = new Set(favs.map((f) => f.cardId));
  const sections: KnownSection[] = [];

  for (const sym of syms) {
    // Investigations: the findings, not the whole report.
    const inv = invs.filter((i) => i.status === "done" && i.report && (on(sym, i.report.listed.map((x) => x.ticker)) || i.report.money_trail.some((m) => new RegExp(`\\b${sym}\\b`).test(m.finding))));
    sections.push({ title: `${sym}: the user's investigations (public records: federal contracts, lobbying, PAC money, headlines)`, lines: inv.slice(0, 3).map((i) => {
      const r = i.report!;
      const x = r.listed.find((l) => l.ticker.toUpperCase() === sym);
      const confirmed = r.money_trail.filter((m) => m.status === "confirmed").slice(0, 3).map((m) => cut(m.finding, 160));
      return `#${i.id} ${i.createdAt.slice(0, 10)} "${cut(r.headline || i.title, 120)}": ${cut(r.what_happened, 300)}${x ? ` Exposure: ${x.direction} ${sym}, ${cut(x.why, 200)}${x.catalyst ? ` Catalyst: ${cut(x.catalyst, 100)}${x.catalyst_date ? ` (${x.catalyst_date})` : ""}` : ""}.` : ""}${confirmed.length ? ` Confirmed by the records: ${confirmed.join("; ")}.` : " Nothing confirmed by the records yet."}`;
    }) });

    // Earlier cards: what was argued, and how it is doing.
    const mine = cards.filter((c) => c.primaryTicker === sym || c.card.tickers.some((t) => t.symbol === sym));
    sections.push({ title: `${sym}: the scout's earlier cards (newest first)`, lines: mine.slice(0, 5).map((c) => {
      const t = tracks.find((x) => x.cardId === c.id);
      const ret = t?.entryPrice && t.exitPrice ? ((t.exitPrice / t.entryPrice - 1) * (t.direction === "short" ? -1 : 1) * 100).toFixed(1) : null;
      const res = t?.exitDate ? `closed ${t.exitDate}${ret !== null ? `, ${ret}% on the trade` : ""}${t.exitReason ? ` (${t.exitReason})` : ""}` : t?.entryPrice ? `open since ${t.entryDate} at $${t.entryPrice}` : c.status.replace("_", " ");
      return `#${c.id} ${c.createdAt.slice(0, 10)} ${c.direction} ${c.primaryTicker}${favSet.has(c.id) ? " (starred by the user)" : ""}: ${cut(thesisFor(c), 220)} [${res}]`;
    }) });

    sections.push({ title: `${sym}: Themes (what the user's sources agree on)`, lines: themes.flatMap((r) => r.themes.filter((t) => on(sym, t.tickers)).map((t) => `${r.etDate} ${t.direction} ${t.tickers.join("/")}: ${cut(t.one_line || t.title, 200)} Crowding: ${cut(t.crowding, 120)}`)).slice(0, 3) });
    sections.push({ title: `${sym}: Dots (second-order ideas from what is changing)`, lines: dots.flatMap((r) => r.ideas.filter((t) => on(sym, t.tickers)).map((t) => `${r.etDate} ${t.direction} ${t.tickers.join("/")}: ${cut(t.title, 140)}. Chain: ${cut(t.chain.join(" → "), 220)}`)).slice(0, 3) });
    sections.push({ title: `${sym}: rumors (UNVERIFIED claims from fringe sources) and how the checks came out`, lines: rumors.filter((r) => on(sym, r.tickers)).slice(0, 4).map((r) => {
      const c = checks.get(r.id);
      return `${r.createdAt.slice(0, 10)} rumor #${r.id}: ${cut(r.claim, 220)} [${c ? `${c.status.replace("_", " ")}${c.note ? `: ${cut(c.note, 100)}` : ""}` : "not checked yet"}]`;
    }) });

    const ca = (classes?.data ?? []).find((c) => c.symbol === sym);
    const itcs = (itc?.data ?? []).filter((n) => on(sym, n.complainantTickers) || on(sym, n.respondentTickers));
    sections.push({ title: `${sym}: lawsuits (Court tab)`, lines: [
      ...(ca ? [`securities class action announced (${ca.releases} law-firm releases, latest ${ca.lastSeen.slice(0, 10)}${ca.deadline ? `, lead plaintiff deadline ${ca.deadline}` : ""}); these follow a drop and are marketing, not new facts`] : []),
      ...itcs.slice(0, 3).map((n) => `ITC patent case ${n.investigation ?? ""} ${n.date}, ${n.stage}: ${cut(n.product, 100)}; ${on(sym, n.complainantTickers) ? `${sym} is the complainant` : `${sym} is a respondent (an import ban is possible)`}`),
    ] });

    sections.push({ title: `${sym}: FDA dates and trial readouts (Pharma tab)`, lines: [
      ...(fda?.data ?? []).filter((e) => e.symbol === sym || on(sym, e.otherSymbols)).slice(0, 3).map((e) => `FDA ${e.date ?? e.when}: ${cut(e.drug, 60)}, ${cut(e.event, 100)}${e.outcome && !/^pending$/i.test(e.outcome) ? ` → ${cut(e.outcome, 80)}` : ""}`),
      ...(trials?.data ?? []).filter((t) => t.symbol === sym).slice(0, 3).map((t) => `Phase 3 ${t.nct} primary completion ${t.completion}: ${cut(t.drugs.join(", "), 60)} in ${cut(t.conditions.slice(0, 2).join(", "), 80)}`),
    ] });

    const w = watch.get(sym);
    sections.push({ title: `${sym}: SEC filings watch, insider buying and Congress trades`, lines: [
      ...(w && w.status !== "ok" ? [`filing watch: ${cut(w.message, 240)}`] : []),
      ...buys.filter((b) => b.symbol === sym).slice(0, 3).map((b) => `insider purchase filed ${b.filed}: ${b.owner ?? "an insider"} (${b.role ?? "insider"}) bought ${b.value ? `$${Math.round(b.value).toLocaleString("en-US")}` : "shares"}${b.price ? ` at $${b.price}` : ""}${b.routine === false ? ", outside their usual month" : ""}`),
      ...congress.filter((t) => t.symbol === sym).slice(0, 3).map((t) => `Congress: ${t.member} ${/^p/i.test(t.tx) ? "bought" : /^s/i.test(t.tx) ? "sold" : t.tx} ${t.amount} on ${t.txDate} (filed ${t.filed})`),
    ] });
  }
  return knownText(syms, sections, max);
}

/** Short lists for the chat briefing: the latest investigations, themes and Dots ideas, and lawsuits on card stocks. */
export async function recentWork(now = new Date()): Promise<{ investigations: string[]; themes: string[]; dots: string[]; court: string[] }> {
  const safe = async <T,>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };
  const [invs, themes, dots, classes, itc] = await Promise.all([
    safe(() => import("./investigate").then(({ listInvestigations }) => listInvestigations(12)), []),
    safe(() => import("./themes").then(({ themeRuns }) => themeRuns(3)), []),
    safe(() => import("./dots").then(({ dotsRuns }) => dotsRuns(3)), []),
    safe(() => store.cacheGet<import("../sources/court").ClassActionCase[]>("court:class-actions"), null),
    safe(() => store.cacheGet<import("../sources/court").ItcNotice[]>("court:itc"), null),
  ]);
  const since = now.getTime() - 30 * 86400_000;
  return {
    investigations: invs.filter((i) => i.status === "done" && i.report && Date.parse(i.createdAt) >= since).map((i) => `#${i.id} ${i.createdAt.slice(0, 10)} ${cut(i.report!.headline || i.title, 140)}${i.report!.listed.length ? ` → ${i.report!.listed.map((x) => `${x.direction} ${x.ticker}`).join(", ")}` : ""}: ${cut(i.report!.what_happened, 200)}`),
    themes: themes.flatMap((r) => r.themes.map((t) => `${r.etDate} ${t.direction} ${t.tickers.join("/")}: ${cut(t.one_line || t.title, 180)}`)).slice(0, 9),
    dots: dots.flatMap((r) => r.ideas.map((t) => `${r.etDate} ${t.direction} ${t.tickers.join("/")}: ${cut(t.title, 120)} (${cut(t.chain.join(" → "), 160)})`)).slice(0, 12),
    court: [
      ...(classes?.data ?? []).slice(0, 15).map((c) => `class action: ${c.symbol} (${cut(c.company, 40)}), ${c.releases} releases${c.deadline ? `, lead plaintiff deadline ${c.deadline}` : ""}`),
      ...(itc?.data ?? []).filter((n) => n.complainantTickers.length || n.respondentTickers.length).slice(0, 10).map((n) => `ITC ${n.investigation ?? ""} ${n.date} ${n.stage}: ${cut(n.product, 80)} (by ${n.complainantTickers.join("/") || cut(n.complainants[0], 30) || "?"} against ${n.respondentTickers.join("/") || cut(n.respondents[0], 30) || "?"})`),
    ],
  };
}
