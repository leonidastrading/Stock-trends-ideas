import Ticker from "@/components/Ticker";
import type { MarketData } from "@/lib/alpaca";
import { paperResult, vsSpy } from "@/lib/scout/paper-result";
import type { StoredCard, Track } from "@/lib/scout/store";
import { beforeOpen } from "@/lib/scout/tracking";
import { addDays, toEt } from "@/lib/time";

const weekday = (d: string) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Pure: the session a not-yet-entered track enters at, by the tracker's own rule: that day's open for a card written
 * before it, otherwise the next session's. `sessions` are the market's open days (holidays left out); without them
 * every weekday counts.
 */
export function entryDay(cardDate: string, writtenBeforeOpen = false, sessions: string[] = []): string {
  const open = (d: string) => (sessions.length && d >= sessions[0] && d <= sessions[sessions.length - 1] ? sessions.includes(d) : weekday(d));
  let d = writtenBeforeOpen ? cardDate : addDays(cardDate, 1);
  while (!open(d)) d = addDays(d, 1);
  return d;
}

const pct = (x: number | null) => (x === null ? "?" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`);

/** Pure: the closed trades' summary: how many, win rate against SPY, mean and median excess return. */
export function bookStats(rows: Array<{ ret: number; spy: number | null }>): { n: number; wins: number; mean: number | null; median: number | null } {
  // These are all shorts: beating SPY means falling more than it did (SPY's move minus the stock's).
  const ex = rows.filter((r) => r.spy !== null).map((r) => r.ret + r.spy!).sort((a, b) => a - b);
  if (!ex.length) return { n: rows.length, wins: 0, mean: null, median: null };
  const mid = Math.floor(ex.length / 2);
  return { n: ex.length, wins: ex.filter((x) => x > 0).length, mean: ex.reduce((a, b) => a + b, 0) / ex.length, median: ex.length % 2 ? ex[mid] : (ex[mid - 1] + ex[mid]) / 2 };
}

/** The down-drift desk's paper shorts: open positions at the latest price, and a scoreboard of the closed ones. */
export default async function DriftBook({ cards, tracks, data, downgradeIds = [] }: { cards: StoredCard[]; tracks: Track[]; data: MarketData | null; downgradeIds?: number[] }) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const mine = tracks.filter((t) => byId.has(t.cardId) && !t.excluded);
  const open = mine.filter((t) => !t.exitDate).sort((a, b) => (b.entryDate ?? "9").localeCompare(a.entryDate ?? "9"));
  const closed = mine.filter((t) => t.exitDate);
  const syms = [...new Set([...open.map((t) => t.symbol), "SPY"])];
  const snaps = (open.length && data?.getSnapshots ? await data.getSnapshots(syms).catch(() => ({})) : {}) as Record<string, { price: number; delayed?: boolean }>;
  const spyNow = snaps.SPY?.price ?? null;
  const et = toEt(new Date());
  const today = et.date;
  // The market's open days around today, so a pending entry is not promised for a holiday.
  const sessions = (open.some((t) => !t.entryDate) && data ? await data.getCalendar(addDays(today, -10), addDays(today, 10)).catch(() => []) : []).map((x) => x.date);
  const results = closed.map((t) => paperResult(t, null, null)).filter((r): r is NonNullable<typeof r> => !!r);
  const all = bookStats(results);
  const byStatus = (s: string) => bookStats(closed.filter((t) => byId.get(t.cardId)?.status === s).map((t) => paperResult(t, null, null)).filter((r): r is NonNullable<typeof r> => !!r));
  const dg = new Set(downgradeIds);
  const byKind = (down: boolean) => bookStats(closed.filter((t) => dg.has(t.cardId) === down).map((t) => paperResult(t, null, null)).filter((r): r is NonNullable<typeof r> => !!r));
  const rowsByStatus = [["all", all], ["downgrades", byKind(true)], ["other bad news", byKind(false)], ["promoted", byStatus("promoted")], ["late", byStatus("late")]] as const;

  return (
    <>
      <section className="card section">
        <h2>Open paper positions ({open.length})</h2>
        <p className="small muted">The desk&apos;s short cards on paper: entry when the card is written (the live price if the market is open, else the next open), held to the card&apos;s time limit or until its invalidation. Returns are for the short (a falling stock is a gain), at the latest price.</p>
        {open.length === 0 ? <p className="small muted">None open.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>Card</th><th>Entry</th><th className="num">Held</th><th className="num">Return</th><th className="num">vs SPY</th><th>Exit by</th></tr></thead>
            <tbody>{open.map((t) => {
              const c = byId.get(t.cardId)!;
              const r = paperResult(t, snaps[t.symbol]?.price ?? null, spyNow);
              return (
                <tr key={t.cardId}>
                  <td><Ticker symbol={t.symbol} /></td>
                  <td className="small"><a href={`/cards/${c.id}`}>#{c.id}</a> <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span>{t.invalidatedAt ? <span className="tag neg">invalidated</span> : null}</td>
                  <td className="small">{t.entryDate ? `${t.entryDate} @ $${t.entryPrice?.toFixed(2)}` : (() => { const d = entryDay(t.cardDate, beforeOpen(t.cardDate, t.cardAt), sessions); return <span className="muted">{d < today || (d === today && et.minutes >= 9 * 60 + 30) ? `entered at the ${dayLabel(d)} open; the price is written in at the next tracking pass` : `enters ${dayLabel(d)} open`}</span>; })()}</td>
                  <td className="num">{r ? `${r.days}d` : "—"}</td>
                  <td className={`num ${r ? (r.ret >= 0 ? "pos" : "neg") : "muted"}`}>{r ? pct(r.ret) : t.entryDate ? "no price" : "not entered yet"}{r && snaps[t.symbol]?.delayed ? <span className="muted small" title="No recent IEX trade: priced from the whole market, 15 minutes delayed"> ·15m</span> : null}</td>
                  <td className={`num ${r && r.spy !== null ? (vsSpy(t.direction, r)! >= 0 ? "pos" : "neg") : "muted"}`}>{r && r.spy !== null ? pct(vsSpy(t.direction, r)) : "—"}</td>
                  <td className="small">{t.invalidatedAt ? <span className="warn">exits at the next open (invalidated)</span> : t.deadlineDate}{t.maxDrawdownPct !== null ? <span className="muted"> · worst {t.maxDrawdownPct}%</span> : null}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
      <section className="card section">
        <h2>Scoreboard</h2>
        <p className="small muted">Closed paper shorts from this desk, entry to exit, against SPY over the same days. {closed.length === 0 ? "None closed yet: the first ones close when their time limits run out." : `Small samples say little; the Scoreboard tab compares this desk ("Scout · down drift") with the others, per version.`}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Cards</th><th className="num">Closed</th><th className="num">Win vs SPY</th><th className="num">Mean vs SPY</th><th className="num">Median vs SPY</th></tr></thead>
          <tbody>{rowsByStatus.map(([label, s]) => (
            <tr key={label}><td>{label}</td><td className="num">{s.n}</td><td className="num">{s.n ? `${Math.round((s.wins / s.n) * 100)}%` : "—"}</td><td className={`num ${s.mean === null ? "" : s.mean >= 0 ? "pos" : "neg"}`}>{s.mean === null ? "—" : pct(s.mean)}</td><td className={`num ${s.median === null ? "" : s.median >= 0 ? "pos" : "neg"}`}>{s.median === null ? "—" : pct(s.median)}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </>
  );
}
