import { describe, expect, it } from "vitest";
import { notReporting, saysFailed, watchedHealth, WATCHED } from "@/lib/scout/health";

const now = new Date("2026-11-27T15:00:00Z");
const row = (source: string, status: string, hoursAgo: number, detail: string | null = null) => ({ source, status, detail, checkedAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString() });

describe("source health beyond the trend desk", () => {
  it("lists the Cboe option chains and every scheduled job", () => {
    expect(WATCHED.cboe_options.label).toBe("Cboe option chains");
    expect(Object.keys(WATCHED)).toEqual(expect.arrayContaining(["market_prices", "news_stream", "sec_live_8k", "job:petitions", "job:driftlist", "job:upgrades"]));
  });
  it("calls a source that went quiet stale, and one never seen not checked yet", () => {
    const w = watchedHealth([row("cboe_options", "down", 1, "SPY: HTTP 403"), row("news_stream", "ok", 40)], now);
    expect(w.find((x) => x.source === "cboe_options")).toMatchObject({ status: "down", detail: "SPY: HTTP 403" });
    expect(w.find((x) => x.source === "news_stream")!.status).toBe("stale");
    expect(w.find((x) => x.source === "market_prices")!.status).toBe("not checked yet");
  });
  it("names every source that is not reporting for Home", () => {
    const out = notReporting([row("youtube", "missing", 2), row("google_trends", "ok", 2), row("cboe_options", "down", 1), row("job:petitions", "ok", 60), row("job:upgrades", "ok", 0.2)], now, (s) => (s === "youtube" ? "YouTube" : s));
    expect(out).toEqual(["YouTube (missing)", "Cboe option chains (down)", "Job: petitions (stale)"]);
  });
  it("reads failure out of a job's own result line", () => {
    expect(saysFailed("petitions: recent petitions: HTTP 429")).toBe(true);
    expect(saysFailed("movers failed: timeout")).toBe(true);
    expect(saysFailed("upgrades: 3 in the headlines, 1 new, 0 failed")).toBe(false);
    expect(saysFailed("drift list book: 0 new, 0 entered at an open, 0 closed · 10 open")).toBe(false);
  });
});
