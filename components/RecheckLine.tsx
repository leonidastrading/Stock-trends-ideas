import { hasDatabase } from "@/lib/db";
import { recheckStatus, VERDICT_LABEL } from "@/lib/scout/recheck";
import { fmtEtAgo } from "@/lib/time";

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
          <span className="muted">checked {fmtEtAgo(st.recheck.checkedAt)}</span> · {st.recheck.summary.length > 220 ? `${st.recheck.summary.slice(0, 220)}…` : st.recheck.summary}{" "}
          <a href={`/cards/${cardId}#valid-${cardId}`}>full answer</a>
        </>
      )}
      {st.error && <span className="neg"> The last check did not finish: {st.error}.</span>}
    </div>
  );
}
