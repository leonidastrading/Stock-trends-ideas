import { describe, expect, it } from "vitest";
import { quietGate, quietReply } from "@/lib/quiet-hours";

// November: ET = UTC − 5.
const et = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`);

describe("quiet hours", () => {
  it("asleep 8 PM–6 AM ET every day", () => {
    expect(quietGate(et("2026-11-20", "19:59"), "minute").run).toBe(true); // Friday evening
    expect(quietGate(et("2026-11-20", "20:00"), "minute").run).toBe(false);
    expect(quietGate(et("2026-11-23", "05:59"), "minutes").run).toBe(false); // Monday early
    expect(quietGate(et("2026-11-23", "06:00"), "minutes").run).toBe(true);
  });

  it("weekends: once an hour (the first 2 minutes for every-minute jobs, the first 5 for the others)", () => {
    expect(quietGate(et("2026-11-21", "10:00"), "minute").run).toBe(true);
    expect(quietGate(et("2026-11-21", "10:01"), "minute").run).toBe(true);
    expect(quietGate(et("2026-11-21", "10:02"), "minute").run).toBe(false);
    expect(quietGate(et("2026-11-22", "14:04"), "minutes").run).toBe(true);
    expect(quietGate(et("2026-11-22", "14:05"), "minutes").run).toBe(false);
    expect(quietGate(et("2026-11-22", "21:00"), "minutes").run).toBe(false); // weekend night
  });

  it("?force=1 runs anyway", () => {
    const night = et("2026-11-21", "23:30");
    expect(quietReply(new Request("https://x/api/cron/stories"), "minutes", night)?.status).toBe("asleep");
    expect(quietReply(new Request("https://x/api/cron/stories?force=1"), "minutes", night)).toBeNull();
  });
});
