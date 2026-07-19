import { describe, expect, it } from "vitest";

import { changeTimeZone, containsNow, resolveWallTime } from "../../../src/domain/time";

describe("TimePolicy", () => {
  it("uses half-open UTC boundaries and rejects invalid intervals or now values", () => {
    const bounds = { startAt: "2026-07-23T14:00:00Z", endAt: "2026-07-23T15:00:00Z" };

    expect(containsNow(bounds, "2026-07-23T14:00:00Z")).toEqual({ ok: true, contains: true });
    expect(containsNow(bounds, "2026-07-23T14:59:59.999Z")).toEqual({ ok: true, contains: true });
    expect(containsNow(bounds, "2026-07-23T15:00:00Z")).toEqual({ ok: true, contains: false });
    expect(containsNow({ startAt: bounds.endAt, endAt: bounds.startAt }, bounds.startAt)).toMatchObject({ ok: false, error: { code: "invalid-boundary" } });
    expect(containsNow(bounds, "bad")).toMatchObject({ ok: false, error: { code: "invalid-instant" } });
  });

  it("accepts only canonical UTC-Z instants", () => {
    const bounds = { startAt: "2026-07-23T14:00:00Z", endAt: "2026-07-23T15:00:00Z" };
    for (const now of ["2026-07-23T09:30:00-05:00", "2026-07-23T14:30:00+00:00", "2026-07-23T14:30:00.000Z", "2026-07-23T14:30:00z"]) {
      expect(containsNow(bounds, now)).toMatchObject({ ok: false, error: { code: "invalid-instant" } });
    }
    expect(containsNow({ ...bounds, startAt: "2026-07-23T09:00:00-05:00" }, "2026-07-23T14:30:00Z")).toMatchObject({ ok: false, error: { code: "invalid-instant" } });
    expect(containsNow({ ...bounds, endAt: "2026-07-23T15:00:00+00:00" }, "2026-07-23T14:30:00Z")).toMatchObject({ ok: false, error: { code: "invalid-instant" } });
  });

  it("returns typed invalid-zone and malformed-wall-time errors", () => {
    expect(resolveWallTime({ date: "2026-07-23", time: "09:00", timeZone: "Not/AZone" })).toMatchObject({
      ok: false,
      error: { code: "invalid-zone" },
    });
    expect(resolveWallTime({ date: "2026-07-23", time: "09:00", timeZone: "+05:30" })).toMatchObject({
      ok: false,
      error: { code: "invalid-zone" },
    });
    expect(resolveWallTime({ date: "2026-07-23", time: "bad", timeZone: "America/Chicago" })).toMatchObject({ ok: false, error: { code: "invalid-wall-time" } });
    expect(resolveWallTime({ date: "bad", time: "09:00", timeZone: "America/Chicago" })).toMatchObject({ ok: false, error: { code: "invalid-wall-time" } });
  });

  it("does not label ordinary input precision as a DST adjustment", () => {
    expect(resolveWallTime({ date: "2026-07-23", time: "09:00:00", timeZone: "America/Chicago" })).toEqual({
      ok: true,
      instant: "2026-07-23T14:00:00Z",
      timeZone: "America/Chicago",
      wallTime: "2026-07-23T09:00:00",
    });
  });

  it("uses compatible resolution and discloses a spring-forward adjustment", () => {
    expect(resolveWallTime({ date: "2026-03-08", time: "02:30", timeZone: "America/Chicago" })).toEqual({
      ok: true,
      instant: "2026-03-08T08:30:00Z",
      timeZone: "America/Chicago",
      wallTime: "2026-03-08T02:30",
      adjustedBoundary: { requestedWallTime: "2026-03-08T02:30", resolvedWallTime: "2026-03-08T03:30" },
    });
  });

  it("chooses the earlier fall-back instant without changing wall intent", () => {
    expect(resolveWallTime({ date: "2026-11-01", time: "01:30", timeZone: "America/Chicago" })).toEqual({
      ok: true,
      instant: "2026-11-01T06:30:00Z",
      timeZone: "America/Chicago",
      wallTime: "2026-11-01T01:30",
    });
  });

  it("changes zones deterministically while preserving wall intent", () => {
    const intent = { date: "2026-07-23", time: "09:00", timeZone: "America/Chicago" };
    expect(changeTimeZone(intent, "America/New_York")).toEqual({
      ok: true,
      value: { date: "2026-07-23", time: "09:00", timeZone: "America/New_York" },
    });
    expect(changeTimeZone(intent, "+05:30")).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
    expect(changeTimeZone(intent, "Not/AZone")).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
  });

  it("validates the original wall intent before changing its zone", () => {
    const destination = "America/New_York";
    expect(changeTimeZone({ date: "bad", time: "09:00", timeZone: "America/Chicago" }, destination)).toMatchObject({ ok: false, error: { code: "invalid-wall-time" } });
    expect(changeTimeZone({ date: "2026-07-23", time: "bad", timeZone: "America/Chicago" }, destination)).toMatchObject({ ok: false, error: { code: "invalid-wall-time" } });
    expect(changeTimeZone({ date: "2026-07-23", time: "09:00", timeZone: "Not/AZone" }, destination)).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
    expect(changeTimeZone({ date: "2026-07-23", time: "09:00", timeZone: "+05:30" }, destination)).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
  });
});
