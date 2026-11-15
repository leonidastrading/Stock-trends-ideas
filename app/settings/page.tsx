import SetupNotice from "@/components/SetupNotice";
import { SCOUT } from "@/config/scout";
import { hasDatabase } from "@/lib/db";
import { envStatus } from "@/lib/env-status";
import { marketDataFromEnv } from "@/lib/alpaca";
import { allSources } from "@/lib/sources";
import * as store from "@/lib/scout/store";
import { etLabel, toEt } from "@/lib/time";
import RunButtons from "./RunButtons";
import SettingsForm from "./SettingsForm";
import SitesEditor from "./SitesEditor";
import SchwabPanel from "./SchwabPanel";
import { schwabConfig, schwabStatus } from "@/lib/sources/schwab";
import { FEEDS } from "@/config/feeds";
import { SITES } from "@/lib/scout/sites";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ schwab?: string }> }) {
  const env = envStatus();
  if (!hasDatabase()) return <SetupNotice />;
  const [sp, schwab] = await Promise.all([searchParams, schwabStatus().catch(() => ({ configured: !!schwabConfig(), connected: false, expiresAt: null, hoursLeft: null }))]);
  const [settings, health, spend, runs, versions, feedback, sites, articles] = await Promise.all([store.loadSettings(), store.allHealth(), store.spendByDay(30), store.recentRuns(60), store.listVersions(), store.recentFeedback(30), store.listSites(), store.recentSiteArticles(5)]);
  const h = new Map(health.map((x) => [x.source, x]));
  const sources = allSources(marketDataFromEnv());
  const today = toEt(new Date()).date;
  const todaySpend = spend.find((s) => s.date === today);
  return (
    <>
      <h1>Settings</h1>
      <section className="card"><h2>Scout</h2><SettingsForm initial={settings} /></section>
      <section className="card"><h2>Run now</h2><RunButtons /></section>

      <section className="card" id="sources">
        <h2>Data sources</h2>
        <p className="small secondary">Everything the scout reads. Free public sources unless a key is named; keys are set in Vercel and never shown here.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Source</th><th>What the scout gets</th><th>How often</th><th>Used by</th></tr></thead>
          <tbody>{FEEDS.map((f) => (
            <tr key={f.name}>
              <td>{f.name}<div className="small muted">{f.host}</div>{f.key && <div className="small"><span className={process.env[f.key] ? "pos" : "neg"}>{process.env[f.key] ? "key set" : `needs ${f.key}`}</span></div>}</td>
              <td className="small secondary">{f.what}</td><td className="small">{f.when}</td><td className="small">{f.usedBy}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="card" id="schwab">
        <h2>Schwab (short interest)</h2>
        <p className="small secondary">Read-only Schwab market data: the scout reads short interest (% of float short, days to cover) for the Drift tab and its research. It can only call Schwab&apos;s market-data address; your accounts, positions and orders are never reached. Schwab makes you sign in again every 7 days; you get a phone alert the day before it lapses.</p>
        <SchwabPanel configured={schwab.configured} connected={schwab.connected} hoursLeft={schwab.hoursLeft} expiresLabel={schwab.expiresAt ? etLabel(schwab.expiresAt) : null} message={sp.schwab ?? null} />
        {!schwab.configured && (
          <ol className="small secondary">
            <li>On developer.schwab.com, open your app and add this callback URL (keep your existing ones): <code>https://trend-scout-livid.vercel.app/api/schwab/callback</code>. Schwab may take a little while to approve the change.</li>
            <li>In Vercel → trend-scout → Settings → Environment Variables, add <code>SCHWAB_APP_KEY</code> and <code>SCHWAB_APP_SECRET</code> (your app&apos;s key and secret) and <code>SCHWAB_CALLBACK_URL</code> = the URL above, then redeploy.</li>
            <li>Come back here and press Connect Schwab.</li>
          </ol>
        )}
      </section>

      <section className="card" id="websites">
        <h2>Your websites</h2>
        <p className="small secondary">Add any site with news or analysis (a blog, a newsletter archive, a company newsroom, an industry site). The scout reads it once a day: its RSS feed if it has one, otherwise the article links on the page. Articles already there when you add it are only recorded; new ones (up to {SITES.maxArticlesPerRead} a day per site) are read for trade ideas, and up to {SITES.maxIdeasPerRead} ideas a day per site go to research. Their cards score as &quot;Scout · your websites&quot;. Sites behind a login or a bot check cannot be read.</p>
        <SitesEditor sites={sites} articles={articles} />
      </section>

      <section className="card">
        <h2>Source health (trend desk)</h2>
        <p className="small secondary">Status from the last scan. "missing" means no key or no data source; "down" means the source failed and the scout said so in its output; "capped" means counts are lower bounds.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Status</th><th>What it measures</th><th>Last check</th><th>Detail</th></tr></thead>
            <tbody>
              {sources.map((s) => {
                const x = h.get(s.id);
                const st = x?.status ?? (s.configured(process.env) ? "not checked yet" : "missing");
                return <tr key={s.id}><td>{s.label}</td><td><span className={`tag ${st.split(" ")[0]}`}>{st}</span></td><td className="small secondary">{s.about}</td><td className="small">{x ? toEt(new Date(x.checkedAt)).date : "—"}</td><td className="small muted">{x?.detail ?? ""}</td></tr>;
              })}
              {(() => {
                const x = h.get("options");
                const st = x?.status ?? "not checked yet";
                return <tr key="options"><td>Options pricing (Alpaca)</td><td><span className={`tag ${st.split(" ")[0]}`}>{st}</span></td><td className="small secondary">For the "how to trade it" note only: at-the-money implied volatility 20–60 days out vs the stock&apos;s 20-day realized volatility. Indicative, 15-minute-delayed feed; not evidence, never tracked.</td><td className="small">{x ? toEt(new Date(x.checkedAt)).date : "—"}</td><td className="small muted">{x?.detail ?? ""}</td></tr>;
              })()}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>LLM spend</h2>
        <p>Today: <b>${(todaySpend?.cost ?? 0).toFixed(2)}</b> of ${settings.dailyCapUsd} cap over {todaySpend?.calls ?? 0} calls.</p>
        <div className="table-wrap"><table><thead><tr><th>Day</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
          <tbody>{spend.map((s) => <tr key={s.date}><td>{s.date}</td><td className="num">{s.calls}</td><td className="num">${s.cost.toFixed(2)}</td></tr>)}{spend.length === 0 && <tr><td colSpan={3} className="muted">No calls yet.</td></tr>}</tbody></table></div>
      </section>

      <section className="card">
        <h2>Versions and frozen rules</h2>
        <p className="small secondary">A version is the sha256 of the model, effort, prompt, reply schema, gates, source list and baseline universe. Changing any of them starts a new version. Never tune the prompt on the version being scored.</p>
        <ul className="small">{versions.map((v) => <li key={v.id}>v{v.id} · {v.model} · {v.effort} · {v.hash.slice(0, 16)} · since {toEt(new Date(v.createdAt)).date}</li>)}{versions.length === 0 && <li className="muted">No version yet (created on the first model call).</li>}</ul>
        <p className="small secondary">Gates: materiality under {SCOUT.minRevenueSharePct}% of revenue or no estimate = logged, not promoted; stock up more than {SCOUT.lateStockMove30dPct}% in 30 days or more than {SCOUT.lateNewsStories30d} mainstream stories in 30 days = late. Candidate rule: at least {SCOUT.minAcceleratingSources} sources up {SCOUT.minChangeVs12m * 100}% or more against their 12-month base, or an event's odds moving {SCOUT.minOddsMovePoints}+ points in a week; {SCOUT.candidateCooldownDays}-day cooldown per term.</p>
      </section>

      <section className="card">
        <h2>Your reactions</h2>
        <p className="small secondary">Thumbs up and down from the cards and stories, newest first. The discovery and story desks see the latest 12 of each kind, with your notes, when they decide what to propose. They do not change how cards are written or gated.</p>
        <ul className="small">{feedback.map((f) => <li key={f.id}>{f.vote === "up" ? "👍" : "👎"} {f.about}{f.note ? <span className="muted"> — “{f.note}”</span> : null}</li>)}{feedback.length === 0 && <li className="muted">None yet.</li>}</ul>
      </section>

      <section className="card">
        <h2>Connections and keys</h2>
        <p className="small secondary">Whether each setting is present. Values are never shown.</p>
        <div className="table-wrap"><table><thead><tr><th>Variable</th><th>Set</th><th>For</th></tr></thead>
          <tbody>{env.map((e) => <tr key={e.key}><td><code>{e.key}</code>{e.required && <span className="tag">required</span>}</td><td className={e.set ? "pos" : e.required ? "neg" : "muted"}>{e.set ? "yes" : "no"}</td><td className="small secondary">{e.group}</td></tr>)}</tbody></table></div>
      </section>

      <section className="card">
        <h2>Recent runs</h2>
        <div className="table-wrap"><table><thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>{collapseRuns(runs).map(({ r, n, from }) => <tr key={r.id}><td className="small">{etLabel(r.startedAt)}{n > 1 ? <div className="muted">back to {etLabel(from, true)}</div> : null}</td><td>{r.action}{n > 1 ? <span className="small muted"> ×{n}</span> : null}</td><td><span className={`tag ${r.status === "ok" ? "ok" : r.status === "error" ? "error" : "capped"}`}>{r.status}</span></td><td className="small muted">{r.error ?? summarize(r.detail)}</td></tr>)}{runs.length === 0 && <tr><td colSpan={4} className="muted">No runs yet. Vercel cron calls /api/cron/daily at midday on weekdays and /api/cron/track after the close.</td></tr>}</tbody></table></div>
      </section>
    </>
  );
}

/** Consecutive runs of the same job with the same outcome read as one row ("stories ×12, skipped"). */
function collapseRuns<T extends { id: number; action: string; status: string; startedAt: string; error: string | null; detail: unknown }>(runs: T[]): Array<{ r: T; n: number; from: string }> {
  const out: Array<{ r: T; n: number; from: string }> = [];
  for (const r of runs) {
    const prev = out.at(-1);
    if (prev && prev.r.action === r.action && prev.r.status === r.status && (prev.r.error ?? summarize(prev.r.detail)) === (r.error ?? summarize(r.detail))) {
      prev.n++;
      prev.from = r.startedAt;
    } else out.push({ r, n: 1, from: r.startedAt });
  }
  return out;
}

function summarize(d: unknown): string {
  if (!d || typeof d !== "object") return "";
  const o = d as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(o.measured)) parts.push(`${o.measured.length} terms measured`);
  if (Array.isArray(o.researched)) parts.push(`${o.researched.length} researched`);
  if (o.discovery && typeof o.discovery === "object") parts.push(`discovery: ${(o.discovery as { headlinesRead: number }).headlinesRead} headlines, ${((o.discovery as { proposed: unknown[] }).proposed ?? []).length} proposed`);
  if (typeof o.digest === "string") parts.push(`digest: ${o.digest}`);
  if (typeof o.barsWritten === "number") parts.push(`${o.barsWritten} bars`);
  if (Array.isArray(o.detected)) parts.push(`${o.detected.length} stories, ${(o.researched as unknown[]).length} trades researched`);
  if (o.stories && typeof o.stories === "object" && Array.isArray((o.stories as { detected?: unknown[] }).detected)) parts.push(`stories: ${(o.stories as { detected: unknown[] }).detected.length} detected`);
  if (Array.isArray(o.entered)) parts.push(`${o.entered.length} entered, ${(o.exited as unknown[]).length} exited, ${o.open} open`);
  if (typeof o.stoppedEarly === "string") parts.push(o.stoppedEarly);
  if (typeof o.reason === "string") parts.push(o.reason);
  return parts.join(" · ");
}
