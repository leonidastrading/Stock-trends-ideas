import SetupNotice from "@/components/SetupNotice";
import { SCOUT } from "@/config/scout";
import { hasDatabase } from "@/lib/db";
import { envStatus } from "@/lib/env-status";
import { marketDataFromEnv } from "@/lib/alpaca";
import { allSources } from "@/lib/sources";
import * as store from "@/lib/scout/store";
import { toEt } from "@/lib/time";
import RunButtons from "./RunButtons";
import SettingsForm from "./SettingsForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SettingsPage() {
  const env = envStatus();
  if (!hasDatabase()) return <SetupNotice />;
  const [settings, health, spend, runs, versions, feedback] = await Promise.all([store.loadSettings(), store.allHealth(), store.spendByDay(30), store.recentRuns(15), store.listVersions(), store.recentFeedback(30)]);
  const h = new Map(health.map((x) => [x.source, x]));
  const sources = allSources(marketDataFromEnv());
  const today = toEt(new Date()).date;
  const todaySpend = spend.find((s) => s.date === today);
  return (
    <>
      <h1>Settings</h1>
      <section className="card"><h2>Scout</h2><SettingsForm initial={settings} /></section>
      <section className="card"><h2>Run now</h2><RunButtons /></section>

      <section className="card">
        <h2>Source health</h2>
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
          <tbody>{runs.map((r) => <tr key={r.id}><td className="small">{r.startedAt.replace("T", " ").slice(0, 16)}Z</td><td>{r.action}</td><td><span className={`tag ${r.status === "ok" ? "ok" : r.status === "error" ? "error" : "capped"}`}>{r.status}</span></td><td className="small muted">{r.error ?? summarize(r.detail)}</td></tr>)}{runs.length === 0 && <tr><td colSpan={4} className="muted">No runs yet. Vercel cron calls /api/cron/daily on weekday mornings and /api/cron/track after the close.</td></tr>}</tbody></table></div>
      </section>
    </>
  );
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
