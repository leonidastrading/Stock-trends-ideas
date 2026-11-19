import { describe, expect, it } from "vitest";
import { checkCronSecret, cronAuthProblem } from "@/lib/auth";

describe("cron secret", () => {
  const env = { CRON_SECRET: "s3cret-value\n" }; // pasted with a line break
  it("accepts the bearer secret with stray spaces or line breaks, and any case of 'Bearer'", () => {
    expect(checkCronSecret("Bearer s3cret-value", env)).toBe(true);
    expect(checkCronSecret("  bearer  s3cret-value  ", env)).toBe(true);
    expect(checkCronSecret("BEARER s3cret-value\n", env)).toBe(true);
  });
  it("still refuses a wrong, partial or missing secret", () => {
    expect(checkCronSecret("Bearer s3cret-valu", env)).toBe(false);
    expect(checkCronSecret("Bearer other", env)).toBe(false);
    expect(checkCronSecret("s3cret-value-x", env)).toBe(false);
    expect(checkCronSecret(null, env)).toBe(false);
    expect(checkCronSecret("Bearer ", { CRON_SECRET: "  " })).toBe(false);
  });
});

describe("cron secret, hand-pasted values", () => {
  it("accepts Bearer typed twice and quotes around the value", () => {
    const env = { CRON_SECRET: "abc123" };
    expect(checkCronSecret("Bearer Bearer abc123", env)).toBe(true);
    expect(checkCronSecret('Bearer "abc123"', env)).toBe(true);
    expect(checkCronSecret("Bearer: abc123", env)).toBe(true);
    expect(checkCronSecret("Bearer abc124", env)).toBe(false);
  });
  it("says why a call was refused without giving the secret away", () => {
    const env = { CRON_SECRET: "abc123" };
    expect(cronAuthProblem(null, env).reason).toBe("no Authorization header reached the app");
    expect(cronAuthProblem("Bearer abc124", env).reason).toMatch(/same length/);
    expect(cronAuthProblem("Bearer abc1234", env)).toMatchObject({ reason: expect.stringMatching(/different length/), detail: expect.stringContaining("7 chars received, 6 expected") });
    expect(JSON.stringify(cronAuthProblem("Bearer abc124", env))).not.toContain("abc123");
    expect(cronAuthProblem("Bearer x", {}).reason).toMatch(/not set/);
  });
});
