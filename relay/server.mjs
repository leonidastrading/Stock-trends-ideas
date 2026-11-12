/**
 * EDGAR relay: a tiny HTTP service for a network the SEC's full-text search
 * host accepts (it refuses Vercel's addresses). It forwards one GET at a time
 * to an allow-listed host, with the declared SEC User-Agent, and returns the
 * body. No dependencies: `node server.mjs`.
 *
 * Environment:
 *   RELAY_TOKEN          required; callers send "Authorization: Bearer <token>"
 *   SEC_USER_AGENT       required; "Name email" as the SEC asks
 *   RELAY_ALLOWED_HOSTS  optional; comma-separated, default "efts.sec.gov"
 *   PORT                 optional; default 8080
 *
 *   GET /health                      -> { ok: true, hosts: [...] }
 *   GET /fetch?url=<encoded url>     -> upstream status and body
 */
import { createServer } from "node:http";

const DEFAULT_HOSTS = ["efts.sec.gov"];

export function allowed(url, hosts = DEFAULT_HOSTS) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.includes(u.host);
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Build the server; `fetchImpl` is injectable for tests. */
export function createRelay({ token, userAgent, hosts = DEFAULT_HOSTS, fetchImpl = fetch, minIntervalMs = 150 } = {}) {
  if (!token || !userAgent) throw new Error("RELAY_TOKEN and SEC_USER_AGENT are required");
  let lastAt = 0;
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, hosts });
    if (req.method !== "GET" || url.pathname !== "/fetch") return json(res, 404, { error: "not found" });
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth, `Bearer ${token}`)) return json(res, 401, { error: "unauthorized" });
    const target = url.searchParams.get("url") ?? "";
    if (!allowed(target, hosts)) return json(res, 400, { error: "host not allowed" });
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const up = await fetchImpl(target, { headers: { "user-agent": userAgent, accept: "application/json, text/plain, */*", "accept-encoding": "gzip, deflate" }, signal: ctl.signal });
      clearTimeout(timer);
      const body = await up.text();
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/plain", "x-relay-host": new URL(target).host });
      res.end(body);
    } catch (err) {
      json(res, 502, { error: `upstream failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const hosts = (process.env.RELAY_ALLOWED_HOSTS ?? DEFAULT_HOSTS.join(",")).split(",").map((h) => h.trim()).filter(Boolean);
  const server = createRelay({ token: process.env.RELAY_TOKEN, userAgent: process.env.SEC_USER_AGENT, hosts });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`edgar relay listening on ${port} for ${hosts.join(", ")}`));
}
