"use client";

import { useState } from "react";

export interface FormSettings { enabled: boolean; model: string; effort: string; dailyCapUsd: number; maxCandidatesPerScan: number; discoveryPerScan: number; emailDigest: boolean; notifyPromoted: boolean; notifyStories: boolean; notifyReviews: boolean }

export default function SettingsForm({ initial }: { initial: FormSettings }) {
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if ((s.model !== initial.model || s.effort !== initial.effort) && !confirm("Changing the model or effort starts a new version. Results are reported per version. Continue?")) return;
    setBusy(true);
    const res = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    setMsg(res.ok && j.ok ? "Saved. Takes effect on the next run." : (j.errors ?? ["failed"]).join("; "));
  }
  return (
    <form onSubmit={save}>
      <div className="fields">
        <label className="field"><span className="field-label">Scout</span><span className="inline"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> run the daily scan and research</span><span className="field-hint">Off: measurements continue, no model calls.</span></label>
        <label className="field"><span className="field-label">Model</span><input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} /><span className="field-hint">Part of the version.</span></label>
        <label className="field"><span className="field-label">Effort</span><select value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value })}>{["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x}>{x}</option>)}</select><span className="field-hint">Part of the version.</span></label>
        <label className="field"><span className="field-label">Daily LLM cap ($)</span><input type="number" min="0" step="0.5" value={s.dailyCapUsd} onChange={(e) => setS({ ...s, dailyCapUsd: Number(e.target.value) })} /><span className="field-hint">When hit, the scout stops for the day and says so.</span></label>
        <label className="field"><span className="field-label">Watch-list candidates per scan</span><input type="number" min="0" max="50" value={s.maxCandidatesPerScan} onChange={(e) => setS({ ...s, maxCandidatesPerScan: Number(e.target.value) })} /><span className="field-hint">Terms that accelerate against their 12-month base.</span></label>
        <label className="field"><span className="field-label">Discovery candidates per scan</span><input type="number" min="0" max="10" value={s.discoveryPerScan} onChange={(e) => setS({ ...s, discoveryPerScan: Number(e.target.value) })} /><span className="field-hint">Proposed by the model from the day's headlines and trending lists. 0 turns discovery off.</span></label>
        <label className="field"><span className="field-label">Phone: promoted cards</span><span className="inline"><input type="checkbox" checked={s.notifyPromoted} onChange={(e) => setS({ ...s, notifyPromoted: e.target.checked })} /> push each new promoted card</span></label>
        <label className="field"><span className="field-label">Phone: story trades</span><span className="inline"><input type="checkbox" checked={s.notifyStories} onChange={(e) => setS({ ...s, notifyStories: e.target.checked })} /> push story-desk cards (mostly late)</span></label>
        <label className="field"><span className="field-label">Phone: after the catalyst</span><span className="inline"><input type="checkbox" checked={s.notifyReviews} onChange={(e) => setS({ ...s, notifyReviews: e.target.checked })} /> push the post-catalyst verdict</span></label>
        <label className="field"><span className="field-label">Weekly digest email</span><span className="inline"><input type="checkbox" checked={s.emailDigest} onChange={(e) => setS({ ...s, emailDigest: e.target.checked })} /> send on Mondays (needs Resend)</span></label>
      </div>
      <div className="actions"><button className="primary" type="submit" disabled={busy}>Save</button>{msg && <span className="small secondary">{msg}</span>}</div>
    </form>
  );
}
