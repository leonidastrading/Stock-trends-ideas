import { describe, expect, it } from "vitest";
import { isNewSince, openTab } from "../lib/last-visit";

describe("new since you last looked, per tab", () => {
  const t = (hhmm: string) => `2026-11-24T${hhmm}:00Z`;

  it("coming back after a while: the last time the tab was open becomes the previous visit", () => {
    const r = openTab({ bubbles: t("12:00") }, {}, "bubbles", t("18:30"));
    expect(r.seen.bubbles).toBe(t("18:30"));
    expect(r.prev.bubbles).toBe(t("12:00"));
    // Listed at 6:11 PM, after the noon visit: new. Listed the day before: not.
    expect(isNewSince(r.prev, "bubbles", t("18:11"))).toBe(true);
    expect(isNewSince(r.prev, "bubbles", "2026-11-23T18:06:00Z")).toBe(false);
  });

  it("a reload, or the menu's own check a minute later, is the same visit: the flags stay", () => {
    let s = openTab({ bubbles: t("12:00") }, {}, "bubbles", t("18:30"));
    s = openTab(s.seen, s.prev, "bubbles", t("18:31"));
    s = openTab(s.seen, s.prev, "bubbles", t("18:33"));
    expect(s.prev.bubbles).toBe(t("12:00"));
    expect(isNewSince(s.prev, "bubbles", t("18:11"))).toBe(true);
    // Away for a while and back: what was new last time no longer is.
    s = openTab(s.seen, s.prev, "bubbles", t("20:00"));
    expect(s.prev.bubbles).toBe(t("18:33"));
    expect(isNewSince(s.prev, "bubbles", t("18:11"))).toBe(false);
  });

  it("flags nothing on a first visit, for another tab, or for a row with no time", () => {
    const first = openTab({}, {}, "drift", t("09:00"));
    expect(first.prev).toEqual({});
    expect(isNewSince(first.prev, "drift", t("08:00"))).toBe(false);
    expect(isNewSince({ drift: t("09:00") }, "earnings", t("10:00"))).toBe(false);
    expect(isNewSince({ drift: t("09:00") }, "drift", null)).toBe(false);
    // Opening one tab leaves the others' records alone.
    const r = openTab({ drift: t("09:00"), earnings: t("08:00") }, { earnings: t("07:00") }, "drift", t("12:00"));
    expect(r.seen.earnings).toBe(t("08:00"));
    expect(r.prev).toEqual({ earnings: t("07:00"), drift: t("09:00") });
  });
});
