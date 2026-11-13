/**
 * One tap sends a card to the existing Swing ideas log (the spx-ai-agent app)
 * as a paper idea. That app places the paper order on its own paper account
 * and scores it against SPY; this app only records that the card was sent.
 */
import type { StoredCard } from "./store";

export interface SwingIdeaInput {
  ticker: string;
  side: "long" | "short";
  thesis: string;
  catalyst: "news" | "panic_dip" | "theme" | "earnings";
  speculative: boolean;
  notional: number;
  exitRule: "time";
  exitParam: number;
}

/** Pure: map a card onto the swing log's idea shape. */
export function toSwingIdea(c: StoredCard, notional: number): SwingIdeaInput {
  const k = c.card;
  const what = k.catalyst.what.toLowerCase();
  const catalyst = /earnings|results|quarter/.test(what) ? "earnings" : c.kind === "event" ? "news" : "theme";
  const thesis = [`[Trend scout card #${c.id}, ${c.origin}] ${k.title}.`, k.observation, `Not priced: ${k.why_not_priced}`, `Invalidation: ${k.invalidation}`, `Catalyst: ${k.catalyst.what} (${k.catalyst.date}).`].join(" ").slice(0, 1000);
  return { ticker: c.primaryTicker, side: c.direction, thesis, catalyst, speculative: k.confidence < 50, notional, exitRule: "time", exitParam: Math.min(365, Math.max(1, c.timeLimitDays)) };
}

export function swingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.SWING_API_URL && env.SWING_API_USER && env.SWING_API_PASSWORD);
}

export async function sendToSwing(card: StoredCard, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!swingConfigured(env)) throw new Error("SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD are not set");
  const idea = toSwingIdea(card, Number(env.SWING_NOTIONAL ?? 5000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Basic ${Buffer.from(`${env.SWING_API_USER}:${env.SWING_API_PASSWORD}`).toString("base64")}`,
  };
  if (env.SWING_API_BYPASS) headers["x-vercel-protection-bypass"] = env.SWING_API_BYPASS;
  const res = await fetchImpl(`${env.SWING_API_URL!.replace(/\/$/, "")}/api/swing`, { method: "POST", headers, body: JSON.stringify(idea) });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { errors: [explain401(res, text)] };
  }
  if (res.status === 401 && !(body as { errors?: unknown }).errors) body = { errors: [explain401(res, text)] };
  return { ok: res.ok && (body as { ok?: boolean }).ok !== false, status: res.status, body };
}

/** Which of the two gates in front of the Swing ideas app refused: Vercel's deployment protection, or the app's own login. */
export function explain401(res: { status: number; headers: { get(name: string): string | null } }, text: string): string {
  if (res.status !== 401) return `swing log replied ${res.status}: ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`;
  if (res.headers.get("www-authenticate")) return "the Swing ideas app rejected the login: SWING_API_USER / SWING_API_PASSWORD must equal that app's DASHBOARD_USER / DASHBOARD_PASSWORD";
  return "Vercel's deployment protection on the Swing ideas app blocked the call: SWING_API_BYPASS must be that project's \"Protection Bypass for Automation\" secret";
}
