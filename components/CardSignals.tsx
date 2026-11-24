import { hasDatabase } from "@/lib/db";
import { crowdingFor, STAGE_LABEL, timing, type CrowdingRow } from "@/lib/scout/crowding";
import { diffsFor } from "@/lib/scout/filing-diff";
import { coverageOf } from "@/lib/sources/coverage";
import { digestsFor } from "@/lib/scout/site-digest";
import { latestRechecks, VERDICT_LABEL, type Recheck } from "@/lib/scout/recheck";
import { fmtEtAgo } from "@/lib/time";
import { siteChanges, type SiteChange } from "@/lib/scout/site-watch";
import { savedCopies } from "@/lib/scout/evidence-archive";

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

function priceLine(rc: Recheck): string {
  if (!rc.priceThen || !rc.priceNow) return "";
  const move = Math.round((rc.priceNow / rc.priceThen - 1) * 1000) / 10;
  return ` · ${"$"}${rc.priceThen.toFixed(2)} when written, ${"$"}${rc.priceNow.toFixed(2)} now (${move > 0 ? "+" : ""}${move}%)`;
}

/** On a card: how crowded the stock was when the card was written and is now, analyst coverage, and the latest filing change. */
export default async function CardSignals({ cardId, symbol }: { cardId: number; symbol: string }) {
  if (!hasDatabase()) return null;
  const [crowd, cov, diffs, sites, rechecks, web, saved] = await Promise.all([crowdingFor([cardId]).catch(() => new Map()), coverageOf([symbol]).catch(() => new Map()), diffsFor([symbol], 1).catch(() => []), digestsFor([symbol], 60, 3).catch(() => []), latestRechecks([cardId]).catch(() => new Map<number, Recheck>()), siteChanges([symbol], 120, 3).catch(() => [] as SiteChange[]), savedCopies(`card:${cardId}`).catch(() => [])]);
  const rc = rechecks.get(cardId);
  const c = crowd.get(cardId);
  const cv = cov.get(symbol);
  const d = diffs[0];
  if (!c?.entry && !c?.latest && !cv && !d && !sites.length && !rc && !web.length && !saved.some((x) => x.archiveUrl)) return null;
  return (
    <>
      {rc && <><dt id={`valid-${cardId}`}>Still valid?</dt><dd className="small">
        <span className={`tag ${VERDICT_LABEL[rc.verdict][1]}`}>{VERDICT_LABEL[rc.verdict][0]}</span> <span className="muted">checked {fmtEtAgo(rc.checkedAt)}{priceLine(rc)}</span>
        <div>{rc.summary}</div>
        {rc.changed.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{rc.changed.map((x, i) => <li key={i}>{x}</li>)}</ul>}
        {rc.catalystStatus && <div><span className="muted">Catalyst:</span> {rc.catalystStatus}</div>}
        {rc.watchNext && <div><span className="muted">Watch next:</span> {rc.watchNext}</div>}
        {rc.paperView && <div><span className="muted">Paper view:</span> {rc.paperView}</div>}
      </dd></>}
      {(c?.entry || c?.latest) && <><dt>Crowding</dt><dd className="small">
        {c.entry ? <Reading r={c.entry} label="when written" /> : <div className="muted">When written: not recorded (card from before crowding was measured).</div>}
        {c.latest && <Reading r={c.latest} label={`latest (${c.latest.measuredOn})`} />}
        <div className="muted">Rules of thumb from the research, not a tested model: early (stage 0–1) is the best entry; late (3–4) means the crowd is there. The scoreboard checks whether it helps.</div>
      </dd></>}
      {web.length > 0 && <><dt>Company website</dt><dd className="small">{web.map((w) => <div key={w.id}>
        <span className={`tag ${w.read?.direction === "negative" ? "error" : w.read?.direction === "positive" ? "ok" : ""}`}>{w.read?.direction ?? "changed"}</span> <b>{w.kind} page</b> <a href={w.url} target="_blank" rel="noreferrer">now</a>{w.oldUrl ? <> · <a href={w.oldUrl} target="_blank" rel="noreferrer">before ({w.oldDate})</a></> : <span className="muted"> · before: {w.oldDate}</span>}{w.newUrl ? <> · <a href={w.newUrl} target="_blank" rel="noreferrer">saved copy</a></> : null} <span className="muted">({fmtEtAgo(w.foundAt)})</span>
        {w.read?.headline ? <div>{w.read.headline}</div> : null}
        {w.read?.findings.length ? <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>{w.read.findings.slice(0, 3).map((f, i) => <li key={i}>{f.what} <span className="muted">“{f.quote.slice(0, 160)}”</span></li>)}</ul> : null}
      </div>)}</dd></>}
      {saved.some((x) => x.archiveUrl) && <><dt>Saved sources</dt><dd className="small">{saved.filter((x) => x.archiveUrl).map((x) => <div key={x.url}><a href={x.archiveUrl!} target="_blank" rel="noreferrer">saved copy</a> <span className="muted">of {x.url.replace(/^https?:\/\//, "").slice(0, 90)}</span></div>)}<div className="muted">Saved to the Wayback Machine when the card was written, so the sources stay checkable if they change.</div></dd></>}
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
