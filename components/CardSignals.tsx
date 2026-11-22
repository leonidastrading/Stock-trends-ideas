import { hasDatabase } from "@/lib/db";
import { crowdingFor, STAGE_LABEL, timing, type CrowdingRow } from "@/lib/scout/crowding";
import { diffsFor } from "@/lib/scout/filing-diff";
import { coverageOf } from "@/lib/sources/coverage";
import { digestsFor } from "@/lib/scout/site-digest";

const FLAG: Record<string, [string, string]> = { red_flag: ["red flag", "error"], positive: ["positive", "ok"], mixed: ["mixed", "late"], routine: ["routine", ""], no_prior: ["no prior year", ""], error: ["not read", ""] };

function Reading({ r, label }: { r: CrowdingRow; label: string }) {
  const p = r.parts;
  const t = timing(r.stage);
  const bits = [
    p.attention ? `Stocktwits ${p.attention.perHour}/h${p.attention.z !== null ? ` (${p.attention.z > 0 ? "+" : ""}${p.attention.z}σ)` : ` (baseline building, ${p.attention.days} days)`}${p.attention.bullishShare !== null ? `, ${Math.round(p.attention.bullishShare * 100)}% bullish` : ""}` : null,
    p.news ? `news ${p.news.stories30d}/30d vs usual ${p.news.baseline30d ?? "?"}` : null,
    p.search?.ratio !== null && p.search?.ratio !== undefined ? `searches ×${p.search.ratio}` : null,
    p.extension ? `${p.extension.pctAbove > 0 ? "+" : ""}${p.extension.pctAbove}% vs 200-day` : null,
    p.run?.move30 !== null && p.run?.move30 !== undefined ? `${p.run.move30 > 0 ? "+" : ""}${p.run.move30}% in 30d` : null,
  ].filter(Boolean);
  return (
    <div>
      <span className="muted">{label}:</span>{" "}
      {r.score === null ? <span className="muted">not scored (too few parts)</span> : <><b className={t === "late" ? "neg" : t === "early" ? "pos" : "warn"}>{r.score}/100 · stage {r.stage} ({STAGE_LABEL[r.stage!]})</b> <span className="muted">{t}</span></>}
      {bits.length > 0 && <span className="muted"> · {bits.join(" · ")}</span>}
    </div>
  );
}

/** On a card: how crowded the stock was when the card was written and is now, analyst coverage, and the latest filing change. */
export default async function CardSignals({ cardId, symbol }: { cardId: number; symbol: string }) {
  if (!hasDatabase()) return null;
  const [crowd, cov, diffs, sites] = await Promise.all([crowdingFor([cardId]).catch(() => new Map()), coverageOf([symbol]).catch(() => new Map()), diffsFor([symbol], 1).catch(() => []), digestsFor([symbol], 60, 3).catch(() => [])]);
  const c = crowd.get(cardId);
  const cv = cov.get(symbol);
  const d = diffs[0];
  if (!c?.entry && !c?.latest && !cv && !d && !sites.length) return null;
  return (
    <>
      {(c?.entry || c?.latest) && <><dt>Crowding</dt><dd className="small">
        {c.entry ? <Reading r={c.entry} label="when written" /> : <div className="muted">When written: not recorded (card from before crowding was measured).</div>}
        {c.latest && <Reading r={c.latest} label={`latest (${c.latest.measuredOn})`} />}
        <div className="muted">Rules of thumb from the research, not a tested model: early (stage 0–1) is the best entry; late (3–4) means the crowd is there. The scoreboard checks whether it helps.</div>
      </dd></>}
      {sites.length > 0 && <><dt>Your websites</dt><dd className="small">{sites.map((x) => <div key={x.url}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a> <span className="muted">({x.site}{x.published ? `, ${x.published.slice(0, 10)}` : ""})</span> — {x.summary}</div>)}</dd></>}
      {cv && <><dt>Analyst coverage</dt><dd className="small">{cv.analysts === null ? "not known" : <><b className={cv.band === "low" ? "pos" : ""}>{cv.band} coverage</b> <span className="muted">({cv.analysts} analyst{cv.analysts === 1 ? "" : "s"}, Finnhub)</span></>}</dd></>}
      {d && <><dt>Filing changes</dt><dd className="small">
        <span className={`tag ${FLAG[d.flag]?.[1] ?? ""}`}>{FLAG[d.flag]?.[0] ?? d.flag}</span> <a href={d.url} target="_blank" rel="noreferrer">{d.form} filed {d.filed}</a> vs <a href={d.priorUrl ?? "#"} target="_blank" rel="noreferrer">a year earlier</a>
        {d.read ? <>: {d.read.headline}{d.read.findings.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{d.read.findings.slice(0, 4).map((f, i) => <li key={i}><span className={f.direction === "negative" ? "neg" : f.direction === "positive" ? "pos" : "muted"}>{f.direction}</span> · {f.why} <span className="muted">“{f.quote.slice(0, 200)}”</span></li>)}</ul>}</> : <span className="muted"> · {d.flag === "routine" ? `little changed (risk-factor similarity ${d.similarity ?? "?"})` : d.error ?? ""}</span>}
        {" "}<a className="muted" href={`/filings#diff-${d.accession}`}>all filing changes</a>
      </dd></>}
    </>
  );
}
