import { describe, expect, it } from "vitest";
import { basicHeader, checkBasicAuth, checkSession, makeSession } from "@/lib/auth";

const env = { DASHBOARD_USER: "vadim", DASHBOARD_PASSWORD: "s3cret" };

describe("remembered sign-in cookie", () => {
  it("accepts its own cookie until it expires; rejects tampering and a changed password", async () => {
    const now = Date.parse("2026-11-17T17:00:00Z");
    const v = (await makeSession(env, now))!;
    expect(await checkSession(v, env, now + 1000)).toBe(true);
    expect(await checkSession(v, env, now + 181 * 86400_000)).toBe(false);
    const [exp, sig] = v.split(".");
    expect(await checkSession(`${Number(exp) + 1}.${sig}`, env, now)).toBe(false);
    expect(await checkSession(`${exp}.${sig.slice(0, -2)}xx`, env, now)).toBe(false);
    expect(await checkSession(v, { ...env, DASHBOARD_PASSWORD: "new" }, now)).toBe(false);
    expect(await checkSession(undefined, env, now)).toBe(false);
    expect(await makeSession({}, now)).toBeNull();
  });

  it("hands the app the same login header a browser would send", () => {
    expect(checkBasicAuth(basicHeader(env), env)).toBe(true);
    expect(basicHeader({})).toBeNull();
  });
});
