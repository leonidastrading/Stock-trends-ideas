/** Guard: this app has no way to reach a broker's order, position or account endpoints. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlyEndpoint, DATA_HOST, PAPER_TRADING_HOST, TRADING_HOST } from "@/lib/alpaca";

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

describe("read-only guard", () => {
  it("the Alpaca client refuses anything but bars, news and the calendar", () => {
    expect(() => assertReadOnlyEndpoint(DATA_HOST, "/v2/stocks/bars")).not.toThrow();
    expect(() => assertReadOnlyEndpoint(TRADING_HOST, "/v2/calendar")).not.toThrow();
    for (const host of [TRADING_HOST, PAPER_TRADING_HOST, DATA_HOST]) for (const path of ["/v2/orders", "/v2/positions", "/v2/account", "/v2/orders/abc"]) expect(() => assertReadOnlyEndpoint(host, path)).toThrow(/read-only/);
  });
  it("no source file mentions an order, position or account endpoint", () => {
    const src = [...files("lib"), ...files("app"), ...files("components"), ...files("config"), ...files("scripts")];
    for (const f of src) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\/v2\/orders|\/v2\/positions|\/v2\/account\b|submitOrder|placeOrder/);
    }
  });
});
