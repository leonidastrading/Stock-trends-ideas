import { hasDatabase } from "@/lib/db";
import { recheckStatus, VERDICT_LABEL } from "@/lib/scout/recheck";
import { fmtEtAgo } from "@/lib/time";

const pctMove = (then: number, now: number) => { const m = Math.round((now / then - 1) * 1000) / 10; return `${m > 0 ? "+" : ""}${m}%`; };

/** Under a card's buttons: where its "Still valid?" check stands (the last verdict, a check still running, or why it failed). */
export default async function RecheckLine({ cardId }: { cardId: number }) {
  if (!hasDatabase()) return null;
  const st = await recheckStatus(cardId).catch(() => null);
  if (!st || (!st.recheck && !st.runningSince && !st.error)) return null;
  return (
    <div className="small" style={{ marginTop: 6 }}>
      <span className="muted">Still valid? </span>
      {st.runningSince && <span className="warn">checking now (started {fmtEtAgo(st.runningSince)}); the answer appears here when it is done. </span>}
      {st.recheck && (
        <>
          <span className={`tag ${VERDICT_LABEL[st.recheck.verdict][1]}`}>{VERDICT_LABEL[st.recheck.verdict][0]}</span>{" "}
          <span className="muted">checked {fmtEtAgo(st.recheck.checkedAt)}</span> · {st.recheck.summary.length > 220 ? `${st.recheck.summary.slice(0, 220)}…` : st.recheck.summary}
          {/* The whole answer opens right here: a link to it further up the card did not work (that part of the card loads late). */}
          <details style={{ marginTop: 4 }}>
            <summary className="recheck-full">full answer</summary>
            <div style={{ marginTop: 4 }}>
              {st.recheck.priceThen && st.recheck.priceNow ? <div className="muted">${st.recheck.priceThen.toFixed(2)} when written, ${st.recheck.priceNow.toFixed(2)} now ({pctMove(st.recheck.priceThen, st.recheck.priceNow)})</div> : null}
              <div>{st.recheck.summary}</div>
              {st.recheck.changed.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{st.recheck.changed.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {st.recheck.catalystStatus && <div><span className="muted">Catalyst:</span> {st.recheck.catalystStatus}</div>}
              {st.recheck.watchNext && <div><span className="muted">Watch next:</span> {st.recheck.watchNext}</div>}
              {st.recheck.paperView && <div><span className="muted">Paper view:</span> {st.recheck.paperView}</div>}
            </div>
          </details>
        </>
      )}
      {st.error && <span className="neg"> The last check did not finish: {st.error}.</span>}
    </div>
  );
}
