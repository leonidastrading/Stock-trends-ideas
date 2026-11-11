/**
 * The one outbound fetch helper for public sources: timeout, retries on 429/5xx,
 * a per-host minimum interval (rate limits) and a short in-memory cache.
 * Credentials are passed by the caller as headers and never logged.
 */

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

const lastByHost = new Map<string, number>();
const cache = new Map<string, { at: number; body: string; status: number }>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GetOptions {
  headers?: Record<string, string>;
  /** Minimum ms between requests to this host (default 250). */
  minIntervalMs?: number;
  /** Cache TTL in ms for an identical URL (default 10 minutes; 0 disables). */
  cacheMs?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export async function getText(url: string, opts: GetOptions = {}): Promise<string> {
  const cacheMs = opts.cacheMs ?? 10 * 60000;
  const hit = cache.get(url);
  if (cacheMs > 0 && hit && Date.now() - hit.at < cacheMs) return hit.body;
  const host = new URL(url).host;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastByHost.get(host) ?? 0) + (opts.minIntervalMs ?? 250) - Date.now();
    if (wait > 0) await sleep(wait);
    lastByHost.set(host, Date.now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000);
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json, text/plain, */*", ...opts.headers }, signal: ctl.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= retries) throw err;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    clearTimeout(timer);
    const body = await res.text();
    if (res.ok) {
      if (cacheMs > 0) cache.set(url, { at: Date.now(), body, status: res.status });
      return body;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? Math.min(ra * 1000, 30000) : 500 * 2 ** attempt);
      continue;
    }
    throw new HttpError(`${host} ${res.status}: ${body.slice(0, 200)}`, res.status, body);
  }
}

export async function getJson<T>(url: string, opts: GetOptions = {}): Promise<T> {
  return JSON.parse(await getText(url, opts)) as T;
}

export function clearHttpCache(): void {
  cache.clear();
  lastByHost.clear();
}
