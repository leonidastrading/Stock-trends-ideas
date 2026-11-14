/**
 * Phone notifications through ntfy (https://ntfy.sh): free apps for iPhone and
 * Android, no account. Install the app, subscribe to the topic in NTFY_TOPIC,
 * and every push lands on the phone. The topic name is the only secret, so it
 * is long and random. NTFY_SERVER and NTFY_TOKEN are for a self-hosted or
 * protected server.
 */
export interface Push {
  title: string;
  message: string;
  /** ntfy emoji tags, e.g. chart_with_upwards_trend */
  tags?: string[];
  /** URL opened when the notification is tapped */
  click?: string;
  /** 1 (min) to 5 (max); default 3 */
  priority?: 1 | 2 | 3 | 4 | 5;
}

export function pushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.NTFY_TOPIC?.trim();
}

export async function sendPush(p: Push, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  const topic = env.NTFY_TOPIC?.trim();
  if (!topic) throw new Error("NTFY_TOPIC is not set");
  const server = (env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`;
  const res = await fetchImpl(server, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, title: p.title.slice(0, 250), message: p.message.slice(0, 3800), tags: p.tags, click: p.click, priority: p.priority ?? 3 }),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 160)}`);
}
