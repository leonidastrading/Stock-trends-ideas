/** Resend email. Optional: without RESEND_API_KEY nothing is sent. */

export function emailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.RESEND_API_KEY && env.ALERT_EMAIL);
}

export async function sendEmail(m: { subject: string; html: string; text: string }, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!emailConfigured(env)) return null;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM ?? "Trend scout <onboarding@resend.dev>", to: [env.ALERT_EMAIL], subject: m.subject, html: m.html, text: m.text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id?: string }).id ?? null;
}
