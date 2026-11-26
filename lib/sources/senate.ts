/**
 * Senate periodic transaction reports (STOCK Act), from the Senate's public disclosure search
 * (efdsearch.senate.gov, checked from Vercel's network on 2026-11-15). The site asks visitors to accept
 * its terms (a form with a CSRF token) before searching; the search returns JSON rows linking to each
 * report, and an electronic report is an HTML table: date, owner, ticker, asset, asset type, type, amount.
 * Paper filings are scanned images and are skipped. Only rows with a ticker and asset type Stock or
 * Stock Option are kept.
 */
import { decodeEntities } from "../entities";
import { amountRange, type PtrTrade, type TxKind } from "./house";

const BASE = "https://efdsearch.senate.gov";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export interface SenateReport { docId: string; member: string; filed: string }

/** A browsing session that has accepted the site's terms (cookies kept between requests). */
export class SenateSession {
  private jar = new Map<string, string>();
  constructor(private fetchImpl: typeof fetch = fetch) {}

  private keep(res: Response) {
    const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ?? "").split(/,(?=[^ ;]+=)/);
    for (const c of cookies) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  private headers(extra: Record<string, string> = {}) {
    return { "user-agent": UA, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), ...extra };
  }

  async open(): Promise<void> {
    const home = await this.fetchImpl(`${BASE}/search/home/`, { headers: this.headers() });
    this.keep(home);
    const html = await home.text();
    const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
    if (!home.ok || !token) throw new Error(`Senate disclosures: no agreement form (${home.status})`);
    const agree = await this.fetchImpl(`${BASE}/search/home/`, {
      method: "POST", redirect: "manual",
      headers: this.headers({ "content-type": "application/x-www-form-urlencoded", referer: `${BASE}/search/home/` }),
      body: new URLSearchParams({ prohibition_agreement: "1", csrfmiddlewaretoken: token }).toString(),
    });
    this.keep(agree);
    if (agree.status >= 400) throw new Error(`Senate disclosures: agreement refused (${agree.status})`);
  }

  /** Electronic periodic transaction reports filed since `from` (YYYY-MM-DD), newest first. */
  async reports(from: string): Promise<SenateReport[]> {
    const [y, m, d] = from.split("-");
    const out: SenateReport[] = [];
    for (let start = 0; start < 1000; start += 100) {
      const res = await this.fetchImpl(`${BASE}/search/report/data/`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/x-www-form-urlencoded", referer: `${BASE}/search/`, "x-csrftoken": this.jar.get("csrftoken") ?? "" }),
        body: new URLSearchParams({ start: String(start), length: "100", report_types: "[11]", filer_types: "[]", submitted_start_date: `${m}/${d}/${y} 00:00:00`, submitted_end_date: "", candidate_state: "", senator_state: "", office_id: "", first_name: "", last_name: "", "order[0][column]": "4", "order[0][dir]": "desc" }).toString(),
      });
      this.keep(res);
      if (!res.ok) throw new Error(`Senate disclosures search ${res.status}`);
      const page = parseSenateSearch(await res.json());
      out.push(...page.reports);
      if (page.rows < 100) break;
    }
    return out;
  }

  async report(docId: string): Promise<string> {
    const res = await this.fetchImpl(`${BASE}/search/view/ptr/${docId}/`, { headers: this.headers({ referer: `${BASE}/search/` }) });
    this.keep(res);
    if (!res.ok) throw new Error(`Senate report ${docId}: ${res.status}`);
    return res.text();
  }
}

export const senateReportUrl = (docId: string) => `${BASE}/search/view/ptr/${docId}/`;

const usDate = (s: string) => { const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[#a-z0-9]+;/gi, (e) => decodeEntities(e)).replace(/\s+/g, " ").trim();

/** Pure: the search rows that are electronic transaction reports (paper filings have no table to read). */
export function parseSenateSearch(json: unknown): { rows: number; reports: SenateReport[] } {
  const rows = ((json as { data?: unknown[][] })?.data ?? []) as string[][];
  const reports = rows.flatMap((r) => {
    const id = String(r[3] ?? "").match(/\/search\/view\/ptr\/([0-9a-f-]{36})\//)?.[1];
    const filed = usDate(String(r[4] ?? ""));
    if (!id || !filed) return [];
    return [{ docId: id, member: `${text(String(r[0] ?? ""))} ${text(String(r[1] ?? ""))}`.trim(), filed }];
  });
  return { rows: rows.length, reports };
}

const TX: Record<string, TxKind> = { purchase: "buy", "sale (full)": "sell", "sale (partial)": "partial sale", sale: "sell", exchange: "exchange" };
const OWNER: Record<string, PtrTrade["owner"]> = { self: "self", spouse: "spouse", joint: "joint", child: "child", dependent: "child" };

/** Pure: listed stock and option trades from an electronic Senate report. The notification date is the filing date. */
export function parseSenatePtr(html: string, filed: string): PtrTrade[] {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const out: PtrTrade[] = [];
  for (const row of body.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const c = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    if (c.length < 8) continue;
    const [, date, owner, ticker, , assetType, type, amount] = c;
    const symbol = ticker.replace(/^\$/, "").toUpperCase();
    const kind = /^stock option/i.test(assetType) ? "option" : /^stock$/i.test(assetType) ? "stock" : null;
    const tx = TX[type.toLowerCase()];
    const txDate = usDate(date);
    if (!kind || !tx || !txDate || !/^[A-Z][A-Z0-9.]{0,6}$/.test(symbol)) continue;
    const { low, high } = amountRange(amount);
    out.push({ ord: out.length, owner: OWNER[owner.toLowerCase().split(" ")[0]] ?? "self", symbol, assetType: kind, tx, txDate, notified: filed, amountLow: low, amountHigh: high, amount });
  }
  return out;
}
