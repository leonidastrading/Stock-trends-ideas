import { describe, expect, it } from "vitest";
import { checkCronSecret } from "@/lib/auth";

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
