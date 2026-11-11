import { envStatus } from "@/lib/env-status";

export default function SetupNotice() {
  const missing = envStatus().filter((e) => e.required && !e.set);
  return (
    <section className="card">
      <h2>Finish setup</h2>
      <p>
        The site is deployed, but {missing.length ? "some required settings are missing" : "the database is not reachable"}. Add them in Vercel → this project →{" "}
        <b>Settings → Environment Variables</b> (the database comes from <b>Storage → Create Database → Neon</b>, which adds <code>DATABASE_URL</code>), then redeploy.
      </p>
      {missing.length > 0 && <ul>{missing.map((m) => <li key={m.key}><code>{m.key}</code> <span className="muted small">({m.group})</span></li>)}</ul>}
      <p className="small secondary">Tables are created automatically on first use.</p>
    </section>
  );
}
