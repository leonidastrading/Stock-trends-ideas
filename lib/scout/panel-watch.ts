/**
 * The panel-vote screen for the Pharma tab: for each stock with an FDA decision coming, did an advisory panel vote on
 * it, which way, and does the crowd agree?
 *
 * Where it came from: card #268 (CAPR) shorted into an FDA decision on sentiment alone and was right for a reason it
 * never saw. The panel had voted against the drug months before, and the company's own 10-Q said so, while 88% of
 * tagged Stocktwits messages were bullish. A hard public fact pointing one way and a crowd leaning the other is the
 * setup; this reads the fact from the company's latest 10-Q or 10-K (companies report a panel's vote there even when
 * they never put out an 8-K about it) and the crowd from Stocktwits. Pure code, no AI.
 */
import { getJson } from "../http";
import { panel } from "../market/panels";
import { secTickerList } from "../sources/edgar";
import { fetchSec } from "../sources/filings";
import { latestPanelVote, panelVoteLabel, type PanelVoteRead } from "../sources/panel-vote";
import { fetchFdaCalendar, type FdaEvent } from "../sources/pharma";
import { messageRate, ST_HOST, ST_UA, type StMessage } from "../sources/stocktwits";
import { addDays, toEt } from "../time";
import { pickPair, submissions } from "./filing-diff";
import * as store from "./store";

export const PANEL_WATCH = { key: "panel-watch", perRun: 10, recheckDays: 4, lookbackDays: 540, aheadDays: 150, budgetMs: 150_000, crowdBullish: 60, crowdBearish: 40, minTagged: 8 };

export interface PanelNote {
  symbol: string; checkedAt: string;
  /** The periodic report read (null: none on file, or the company is not in the SEC's list). */
  filing: { form: string; filed: string; url: string; accession: string } | null;
  vote: PanelVoteRead | null;
  /** Share of sentiment-tagged Stocktwits messages that are bullish, in percent (only looked up when there is a vote). */
  bullishPct: number | null; tagged: number | null;
}
export type PanelWatch = Record<string, PanelNote>;

const pendingEvent = (e: FdaEvent) => /^pending$/i.test(e.outcome.trim());

/** Pure: the stocks with an FDA decision still to come (within `aheadDays`, or this month onward when the date is loose), soonest first. */
export function pendingSymbols(events: FdaEvent[], today: string, aheadDays = PANEL_WATCH.aheadDays): string[] {
  const until = addDays(today, aheadDays);
  const when = (e: FdaEvent) => e.date ?? `${e.month ?? "9999-12"}-28`;
  const rows = events.filter((e) => e.symbol && pendingEvent(e) && (e.date ? e.date >= today && e.date <= until : (e.month ?? "") >= today.slice(0, 7) && `${e.month}-01` <= until));
  return [...new Set(rows.sort((a, b) => when(a).localeCompare(when(b))).map((e) => e.symbol!))];
}

/** Pure: whether the crowd leans against the panel (the CAPR setup), in words, or null. */
export function mismatch(n: Pick<PanelNote, "vote" | "bullishPct" | "tagged">): string | null {
  if (!n.vote || n.bullishPct === null || (n.tagged ?? 0) < PANEL_WATCH.minTagged) return null;
  if (n.vote.side === "negative" && n.bullishPct >= PANEL_WATCH.crowdBullish) return `the panel voted against, yet ${n.bullishPct}% of the crowd is bullish`;
  if (n.vote.side === "positive" && n.bullishPct <= PANEL_WATCH.crowdBearish) return `the panel voted in favour, yet only ${n.bullishPct}% of the crowd is bullish`;
  return null;
}

/** Pure: the note as a sentence for a research brief. */
export function panelNoteText(n: PanelNote): string | null {
  if (!n.vote) return null;
  const crowd = n.bullishPct === null ? "" : ` Stocktwits: ${n.bullishPct}% of ${n.tagged} sentiment-tagged recent messages are bullish.`;
  const m = mismatch(n);
  return `FDA advisory panel vote on file: ${panelVoteLabel(n.vote)}${n.vote.said ? ` on ${n.vote.said}` : ""} (from the company's ${n.filing?.form ?? "filing"} filed ${n.filing?.filed ?? "recently"}): "${n.vote.sentence.slice(0, 300)}".${crowd}${m ? ` Mismatch: ${m}.` : ""} The FDA usually, not always, follows its panel.`;
}

const strip = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/g, "&").replace(/&#8211;|&ndash;|&#x2013;/gi, "–").replace(/&#8212;|&mdash;|&#x2014;/gi, "—").replace(/&#8217;|&rsquo;|&#146;|&#x2019;/gi, "'").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");

/** The saved notes, by symbol. */
export async function panelWatch(): Promise<{ notes: PanelWatch; at: string | null }> {
  const c = await store.cacheGet<PanelWatch>(PANEL_WATCH.key).catch(() => null);
  return { notes: c?.data ?? {}, at: c?.updatedAt ?? null };
}

/** One pass: a few of the stocks with a decision coming, the ones never read or not read for a few days first. */
export async function runPanelWatch(env: NodeJS.ProcessEnv = process.env, now = new Date(), fetchImpl?: typeof fetch): Promise<string> {
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return "panel watch: waiting for SEC_USER_AGENT";
  const started = Date.now();
  const today = toEt(now).date;
  const fda = await panel<FdaEvent[]>("pharma:fda", 12 * 60, () => fetchFdaCalendar(today, fetchImpl), 25_000);
  if (!fda.data) return `panel watch: FDA calendar not readable (${fda.error ?? "no data"})`;
  const pending = pendingSymbols(fda.data, today);
  const notes = (await panelWatch()).notes;
  const stale = (s: string) => !notes[s] || now.getTime() - Date.parse(notes[s].checkedAt) > PANEL_WATCH.recheckDays * 86400_000;
  const due = pending.filter(stale).slice(0, PANEL_WATCH.perRun);
  if (!due.length) return `panel watch: ${pending.length} stocks with a decision coming, all read (${Object.values(notes).filter((n) => n.vote).length} with a panel vote)`;
  const ciks = new Map((await secTickerList(ua, fetchImpl)).map((t) => [t.ticker, t.cik]));
  const said: string[] = [];
  let read = 0;
  for (const symbol of due) {
    if (Date.now() - started > PANEL_WATCH.budgetMs) break;
    const prev = notes[symbol];
    const note: PanelNote = { symbol, checkedAt: now.toISOString(), filing: null, vote: null, bullishPct: null, tagged: null };
    try {
      const cik = ciks.get(symbol);
      const latest = cik ? pickPair(await submissions(cik, ua, fetchImpl))?.latest ?? null : null;
      if (latest) {
        note.filing = { form: latest.form, filed: latest.filed, url: latest.url, accession: latest.accession };
        // The same report as last time says the same thing: only the crowd is looked at again.
        note.vote = prev?.filing?.accession === latest.accession ? prev.vote : latestPanelVote(strip(await fetchSec(latest.url, ua, fetchImpl)), addDays(today, -PANEL_WATCH.lookbackDays));
      }
      if (note.vote && note.vote.side !== "split") {
        const stream = await getJson<{ messages?: StMessage[] }>(`${ST_HOST}/streams/symbol/${encodeURIComponent(symbol)}.json?limit=30`, { headers: ST_UA, minIntervalMs: 1500, fetchImpl, cacheMs: 0, retries: 1 }).catch(() => null);
        const tagged = (stream?.messages ?? []).filter((m) => m.entities?.sentiment?.basic).length;
        const rate = messageRate(stream?.messages ?? [], now);
        if (rate?.bullishShare !== null && rate?.bullishShare !== undefined) { note.bullishPct = Math.round(rate.bullishShare * 100); note.tagged = tagged; }
      }
    } catch (err) {
      // Left as "nothing found" and read again next time it is due; one stock's bad filing must not stop the rest.
      console.warn(`panel watch ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
    notes[symbol] = note;
    read++;
    if (note.vote) said.push(`${symbol} ${panelVoteLabel(note.vote)}${note.bullishPct === null ? "" : `, crowd ${note.bullishPct}% bullish`}${mismatch(note) ? " (MISMATCH)" : ""}`);
  }
  // A stock whose decision is no longer pending drops off.
  for (const s of Object.keys(notes)) if (!pending.includes(s)) delete notes[s];
  await store.cachePut(PANEL_WATCH.key, notes);
  return `panel watch: ${read} of ${pending.length} stocks read (${pending.filter(stale).length - read} still due)${said.length ? ` · ${said.join("; ")}` : " · no panel votes in these"}`;
}
