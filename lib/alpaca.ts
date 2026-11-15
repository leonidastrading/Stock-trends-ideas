/**
 * Read-only Alpaca client: daily bars, news, calendar. It can only issue GET
 * requests to an allowlist; there is no code path that places, modifies or
 * cancels an order anywhere in this app.
 */

import { parseCalendar, type Session } from "./time";

export const DATA_HOST = "https://data.alpaca.markets";
export const TRADING_HOST = "https://api.alpaca.markets";
export const PAPER_TRADING_HOST = "https://paper-api.alpaca.markets";

const ALLOWED: Record<string, RegExp[]> = {
  [DATA_HOST]: [/^\/v2\/stocks\/bars$/, /^\/v2\/stocks\/snapshots$/, /^\/v1beta1\/screener\/stocks\/movers$/, /^\/v1beta1\/news$/, /^\/v1beta1\/options\/snapshots\/[A-Z][A-Z.]{0,9}$/],
  // Calendar and asset metadata (what a symbol currently is; the list of stocks for the search box) only: never orders, positions or the account.
  [TRADING_HOST]: [/^\/v2\/calendar$/, /^\/v2\/assets$/, /^\/v2\/assets\/[A-Z][A-Z.]{0,9}$/],
  [PAPER_TRADING_HOST]: [/^\/v2\/calendar$/, /^\/v2\/assets$/, /^\/v2\/assets\/[A-Z][A-Z.]{0,9}$/],
};

export interface AlpacaCreds {
  keyId: string;
  secretKey: string;
}

export class AlpacaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function credsFromEnv(env: NodeJS.ProcessEnv = process.env): AlpacaCreds | null {
  const keyId = env.ALPACA_API_KEY_ID;
  const secretKey = env.ALPACA_API_SECRET_KEY;
  return keyId && secretKey ? { keyId, secretKey } : null;
}

export function referenceHostFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALPACA_PAPER === "true" ? PAPER_TRADING_HOST : TRADING_HOST;
}

export function assertReadOnlyEndpoint(host: string, path: string): void {
  const rules = ALLOWED[host];
  if (!rules || !rules.some((re) => re.test(path))) throw new Error(`Refusing non-allowlisted Alpaca endpoint ${host}${path} (read-only)`);
}

export interface Snapshot { price: number; at: string | null; prevClose: number | null; sessionDate: string | null; volume?: number | null }
export interface Mover { symbol: string; price: number; changePct: number }

export interface Asset { symbol: string; name: string; exchange: string; active: boolean; tradable: boolean }

export interface DailyBar {
  symbol: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface NewsItem {
  id: number;
  ts: string;
  headline: string;
  summary: string;
  symbols: string[];
  source: string;
  url: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AlpacaClient {
  private readonly fetchImpl: typeof fetch;
  private referenceHost: string;
  private lastRequestAt = 0;

  constructor(private readonly opts: { creds: AlpacaCreds; referenceHost?: string; fetchImpl?: typeof fetch; maxRetries?: number }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.referenceHost = opts.referenceHost ?? TRADING_HOST;
  }

  /** The only network primitive here: GET with allowlist, a 190/min throttle and retries. */
  async get<T>(host: string, path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    assertReadOnlyEndpoint(host, path);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${host}${path}?${qs}`;
    const maxRetries = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + 320 - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: "GET", headers: { "APCA-API-KEY-ID": this.opts.creds.keyId, "APCA-API-SECRET-KEY": this.opts.creds.secretKey, accept: "application/json" } });
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(Math.min(1000 * 2 ** attempt, 30000));
        continue;
      }
      throw new AlpacaError(`Alpaca ${res.status} on ${path}: ${body.slice(0, 200)}`, res.status);
    }
  }

  /**
   * Reference data (calendar, asset metadata) lives on the trading host, and paper keys only work on the
   * paper host (live keys only on the live one). If the configured host refuses the keys, try the other
   * once and keep using whichever answered.
   */
  private async refGet<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    try {
      return await this.get<T>(this.referenceHost, path, params);
    } catch (err) {
      if (!(err instanceof AlpacaError && (err.status === 401 || err.status === 403))) throw err;
      const other = this.referenceHost === PAPER_TRADING_HOST ? TRADING_HOST : PAPER_TRADING_HOST;
      const r = await this.get<T>(other, path, params);
      this.referenceHost = other;
      return r;
    }
  }

  /** Daily bars (split-adjusted) for symbols in [start, end], all pages. */
  async getDailyBars(symbols: readonly string[], start: string, end: string): Promise<DailyBar[]> {
    const out: DailyBar[] = [];
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      let pageToken: string | undefined;
      do {
        const resp = await this.get<{ bars: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> | null; next_page_token?: string | null }>(
          DATA_HOST, "/v2/stocks/bars",
          { symbols: chunk.join(","), timeframe: "1Day", start: `${start}T00:00:00Z`, end: `${end}T23:59:59Z`, adjustment: "split", feed: "iex", sort: "asc", limit: 10000, page_token: pageToken },
        );
        for (const [symbol, rows] of Object.entries(resp.bars ?? {})) for (const r of rows ?? []) out.push({ symbol, date: r.t.slice(0, 10), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
        pageToken = resp.next_page_token ?? undefined;
      } while (pageToken);
    }
    return out;
  }

  /** Headlines tagged with any of `symbols` in [start, end), newest first, up to `max`. */
  async getNews(symbols: string[], start: Date, end: Date, max = 500): Promise<NewsItem[]> {
    const out: NewsItem[] = [];
    let pageToken: string | undefined;
    do {
      const resp = await this.get<{ news: Array<{ id: number; headline: string; summary?: string; created_at: string; symbols?: string[]; source?: string; url?: string }> | null; next_page_token?: string | null }>(
        DATA_HOST, "/v1beta1/news",
        { start: start.toISOString(), end: end.toISOString(), symbols: symbols.join(","), sort: "desc", include_content: false, exclude_contentless: false, limit: 50, page_token: pageToken },
      );
      for (const n of resp.news ?? []) out.push({ id: n.id, ts: new Date(n.created_at).toISOString(), headline: n.headline ?? "", summary: n.summary ?? "", symbols: n.symbols ?? [], source: n.source ?? "", url: n.url ?? "" });
      pageToken = resp.next_page_token ?? undefined;
    } while (pageToken && out.length < max);
    return out;
  }

  /** Option contract snapshots (market data only) for one underlying: contract symbol → implied volatility. Free accounts get the 15-minute-delayed indicative feed. */
  async getOptionSnapshots(underlying: string, q: { type?: "call" | "put"; strikeGte?: number; strikeLte?: number; expiryGte?: string; expiryLte?: string }): Promise<Record<string, { impliedVolatility?: number | null }>> {
    const out: Record<string, { impliedVolatility?: number | null }> = {};
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const resp = await this.get<{ snapshots?: Record<string, { impliedVolatility?: number | null }> | null; next_page_token?: string | null }>(
        DATA_HOST, `/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`,
        { type: q.type, strike_price_gte: q.strikeGte, strike_price_lte: q.strikeLte, expiration_date_gte: q.expiryGte, expiration_date_lte: q.expiryLte, limit: 1000, page_token: pageToken },
      );
      Object.assign(out, resp.snapshots ?? {});
      pageToken = resp.next_page_token ?? undefined;
    } while (pageToken && ++pages < 5);
    return out;
  }

  /** Latest trade and the last two daily bars per symbol (market data only; free accounts get the IEX feed). */
  async getSnapshots(symbols: readonly string[]): Promise<Record<string, Snapshot>> {
    const out: Record<string, Snapshot> = {};
    for (let i = 0; i < symbols.length; i += 100) {
      const resp = await this.get<Record<string, { latestTrade?: { p: number; t: string } | null; dailyBar?: { c: number; t: string; v?: number } | null; prevDailyBar?: { c: number; t: string } | null } | null>>(
        DATA_HOST, "/v2/stocks/snapshots", { symbols: symbols.slice(i, i + 100).join(","), feed: "iex" },
      );
      for (const [sym, s] of Object.entries(resp ?? {})) {
        const price = s?.latestTrade?.p ?? s?.dailyBar?.c ?? null;
        if (!s || price === null) continue;
        out[sym] = { price, at: s.latestTrade?.t ?? s.dailyBar?.t ?? null, prevClose: s.prevDailyBar?.c ?? null, sessionDate: s.dailyBar?.t ? s.dailyBar.t.slice(0, 10) : null, volume: s.dailyBar?.v ?? null };
      }
    }
    return out;
  }

  /** The day's biggest gainers and losers across US stocks (market data screener). */
  async getMovers(top = 20): Promise<{ gainers: Mover[]; losers: Mover[] }> {
    const r = await this.get<{ gainers?: Array<{ symbol: string; price: number; percent_change: number }>; losers?: Array<{ symbol: string; price: number; percent_change: number }> }>(DATA_HOST, "/v1beta1/screener/stocks/movers", { top });
    const map = (xs?: Array<{ symbol: string; price: number; percent_change: number }>) => (xs ?? []).map((x) => ({ symbol: x.symbol, price: x.price, changePct: x.percent_change }));
    return { gainers: map(r.gainers), losers: map(r.losers) };
  }

  /** What a symbol currently is: issuer name, exchange, whether it trades. Null when the symbol is unknown. */
  async getAsset(symbol: string): Promise<Asset | null> {
    try {
      const a = await this.refGet<{ symbol: string; name?: string; exchange?: string; status?: string; tradable?: boolean; class?: string }>(`/v2/assets/${encodeURIComponent(symbol)}`, {});
      return { symbol: a.symbol, name: a.name ?? "", exchange: a.exchange ?? "", active: a.status === "active", tradable: !!a.tradable };
    } catch (err) {
      if (err instanceof AlpacaError && (err.status === 404 || err.status === 422)) return null;
      throw err;
    }
  }

  /** Every active US stock and ETF: symbol, name, exchange (for the ticker search). */
  async listAssets(): Promise<Array<{ symbol: string; name: string; exchange: string }>> {
    const xs = await this.refGet<Array<{ symbol: string; name?: string; exchange?: string; tradable?: boolean }>>("/v2/assets", { status: "active", asset_class: "us_equity" });
    return xs.filter((a) => a.tradable !== false).map((a) => ({ symbol: a.symbol, name: a.name ?? "", exchange: a.exchange ?? "" }));
  }

  async getCalendar(start: string, end: string): Promise<Session[]> {
    return parseCalendar(await this.refGet("/v2/calendar", { start, end }));
  }
}

/** Market-data interface the scout depends on; tests supply a fake. */
export interface MarketData {
  getDailyBars(symbols: readonly string[], start: string, end: string): Promise<DailyBar[]>;
  getNews(symbols: string[], start: Date, end: Date, max?: number): Promise<NewsItem[]>;
  getCalendar(start: string, end: string): Promise<Session[]>;
  /** Optional: what a symbol currently is (asset metadata). */
  getAsset?(symbol: string): Promise<Asset | null>;
  /** Optional: every active US stock and ETF (reference data only). */
  listAssets?(): Promise<Array<{ symbol: string; name: string; exchange: string }>>;
  /** Optional: the day's biggest movers (market data only). */
  getMovers?(top?: number): Promise<{ gainers: Mover[]; losers: Mover[] }>;
  /** Optional: latest price and the previous close (market data only). */
  getSnapshots?(symbols: readonly string[]): Promise<Record<string, Snapshot>>;
  /** Optional: option-chain implied volatility (market data only). */
  getOptionSnapshots?(underlying: string, q: { type?: "call" | "put"; strikeGte?: number; strikeLte?: number; expiryGte?: string; expiryLte?: string }): Promise<Record<string, { impliedVolatility?: number | null }>>;
}

export function marketDataFromEnv(env: NodeJS.ProcessEnv = process.env): MarketData | null {
  const creds = credsFromEnv(env);
  return creds ? new AlpacaClient({ creds, referenceHost: referenceHostFromEnv(env) }) : null;
}
