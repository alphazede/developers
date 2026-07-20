import { describe, expect, it } from "vitest";

import {
  changeFocusGateTimeZone,
  evaluateFocusGate,
  reviseFocusGate,
  validateFocusGate,
  type DailyFocusWindow,
  type FocusGateConfig,
} from "../../../src/domain/focus-gate";

const gate = {
  enabled: true as const,
  timeZone: "America/Chicago",
  windows: [
    { id: "morning", startLocalTime: "09:00", endLocalTime: "10:00" },
    { id: "afternoon", startLocalTime: "14:00", endLocalTime: "15:00" },
  ] as const,
};

const withWindows = (...windows: DailyFocusWindow[]): FocusGateConfig => ({ enabled: true, timeZone: "America/Chicago", windows });
const localCreate = { kind: "local-task-create" as const, taskSource: "local" as const };

describe("FocusGatePolicy", () => {
  it("requires disabled or exactly two windows with unique IDs", () => {
    expect(validateFocusGate({ enabled: false })).toEqual({ ok: true, value: { enabled: false } });
    expect(validateFocusGate(withWindows())).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
    expect(validateFocusGate(withWindows(gate.windows[0]))).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
    expect(validateFocusGate(withWindows(...gate.windows, { id: "evening", startLocalTime: "18:00", endLocalTime: "19:00" }))).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
    expect(validateFocusGate(withWindows(
      { id: "same", startLocalTime: "09:00", endLocalTime: "10:00" },
      { id: "same", startLocalTime: "14:00", endLocalTime: "15:00" },
    ))).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
  });

  it("accepts exactly fifteen minutes but rejects shorter, overnight, and malformed windows", () => {
    expect(validateFocusGate(withWindows(
      { id: "exact", startLocalTime: "09:00", endLocalTime: "09:15" },
      gate.windows[1],
    ))).toMatchObject({ ok: true });
    expect(validateFocusGate(withWindows(
      { id: "short", startLocalTime: "09:00", endLocalTime: "09:14:59" },
      gate.windows[1],
    ))).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
    expect(validateFocusGate(withWindows(
      { id: "overnight", startLocalTime: "23:45", endLocalTime: "00:15" },
      gate.windows[0],
    ))).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
    expect(validateFocusGate(withWindows(
      { id: "malformed", startLocalTime: "bad", endLocalTime: "10:00" },
      gate.windows[1],
    ))).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
  });

  it("rejects overlap, allows adjacency, and returns a stable sorted tuple", () => {
    const overlap = withWindows(
      { id: "later", startLocalTime: "09:30", endLocalTime: "10:30" },
      { id: "earlier", startLocalTime: "09:00", endLocalTime: "10:00" },
    );
    const adjacent = withWindows(
      { id: "later", startLocalTime: "10:00", endLocalTime: "11:00" },
      { id: "earlier", startLocalTime: "09:00", endLocalTime: "10:00" },
    );
    expect(validateFocusGate(overlap)).toMatchObject({ ok: false, error: { code: "invalid-focus-gate" } });
    expect(validateFocusGate(adjacent)).toEqual({
      ok: true,
      value: {
        enabled: true,
        timeZone: "America/Chicago",
        windows: [
          { id: "earlier", startLocalTime: "09:00", endLocalTime: "10:00" },
          { id: "later", startLocalTime: "10:00", endLocalTime: "11:00" },
        ],
      },
    });
    expect(validateFocusGate({ ...gate, windows: [...gate.windows].reverse() })).toEqual(validateFocusGate(gate));
  });

  it("uses half-open boundaries for both daily windows", () => {
    for (const [now, allowed] of [
      ["2026-07-23T13:59:59.999Z", false],
      ["2026-07-23T14:00:00Z", true],
      ["2026-07-23T14:59:59.999Z", true],
      ["2026-07-23T15:00:00Z", false],
      ["2026-07-23T18:59:59.999Z", false],
      ["2026-07-23T19:00:00Z", true],
      ["2026-07-23T19:59:59.999Z", true],
      ["2026-07-23T20:00:00Z", false],
    ] as const) {
      expect(evaluateFocusGate(localCreate, now, gate)).toMatchObject({ ok: true, allowed });
    }
  });

  for (const kind of ["local-task-create", "local-task-edit", "local-task-complete"] as const) {
    it(`gates local ${kind} only while open`, () => {
      const command = { kind, taskSource: "local" as const };
      expect(evaluateFocusGate(command, "2026-07-23T14:30:00Z", gate)).toMatchObject({ ok: true, allowed: true });
      expect(evaluateFocusGate(command, "2026-07-23T15:30:00Z", gate)).toMatchObject({ ok: true, allowed: false, code: "focus-gate-closed" });
    });
  }

  for (const source of ["github", "linear"] as const) {
    it(`keeps every ${source} mutation immutable`, () => {
      for (const kind of ["local-task-create", "local-task-edit", "local-task-complete"] as const) {
        expect(evaluateFocusGate({ kind, taskSource: source }, "2026-07-23T14:30:00Z", gate)).toEqual({ ok: true, allowed: false, code: "imported-task-immutable" });
      }
    });
  }

  it("permits non-mutating commands while closed", () => {
    for (const kind of ["task-read", "analysis", "sync"] as const) {
      expect(evaluateFocusGate({ kind }, "2026-07-23T15:30:00Z", gate)).toEqual({ ok: true, allowed: true });
    }
  });

  it("requires confirmation for both settings escapes and keeps confirmed escape reachable", () => {
    for (const kind of ["focus-gate-revise", "focus-gate-disable"] as const) {
      expect(evaluateFocusGate({ kind, confirmed: false }, "bad", gate)).toMatchObject({ ok: false, error: { code: "confirmation-required" } });
      expect(evaluateFocusGate({ kind, confirmed: true }, "bad", { ...gate, timeZone: "Not/AZone" })).toEqual({ ok: true, allowed: true });
    }
    expect(reviseFocusGate(gate, { enabled: false }, false)).toMatchObject({ ok: false, error: { code: "confirmation-required" } });
    expect(reviseFocusGate(gate, { enabled: false }, true)).toEqual({ ok: true, value: { enabled: false } });
    expect(reviseFocusGate(gate, { ...gate, windows: [...gate.windows].reverse() }, true)).toEqual(validateFocusGate(gate));
  });

  it("never authorizes deletion for local or imported tasks", () => {
    for (const taskSource of ["local", "github", "linear"] as const) {
      expect(evaluateFocusGate({ kind: "task-delete", taskSource }, "2026-07-23T14:30:00Z", gate)).toEqual({ ok: true, allowed: false, code: "task-deletion-not-supported" });
    }
  });

  it("returns typed invalid-now, invalid-zone, and unknown-command results", () => {
    expect(evaluateFocusGate(localCreate, "bad", gate)).toMatchObject({ ok: false, error: { code: "invalid-instant" } });
    expect(evaluateFocusGate(localCreate, "2026-07-23T14:30:00Z", { ...gate, timeZone: "Not/AZone" })).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
    expect(evaluateFocusGate(localCreate, "2026-07-23T14:30:00Z", { ...gate, timeZone: "+05:30" })).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
    expect(evaluateFocusGate({ kind: "other" }, "2026-07-23T14:30:00Z", gate)).toMatchObject({ ok: false, error: { code: "unknown-command" } });
  });

  it("changes zones deterministically while preserving sorted wall intent", () => {
    expect(changeFocusGateTimeZone({ ...gate, windows: [...gate.windows].reverse() }, "America/New_York")).toEqual({
      ok: true,
      value: { ...gate, timeZone: "America/New_York" },
    });
    expect(changeFocusGateTimeZone(gate, "Not/AZone")).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
    expect(changeFocusGateTimeZone(gate, "+05:30")).toMatchObject({ ok: false, error: { code: "invalid-zone" } });
  });

  it("resolves compatible spring and fall transitions at either boundary", () => {
    const edgeGate = (startLocalTime: string, endLocalTime: string) => withWindows(
      { id: "edge", startLocalTime, endLocalTime },
      { id: "later", startLocalTime: "10:00", endLocalTime: "11:00" },
    );
    expect(evaluateFocusGate(localCreate, "2026-03-08T08:15:00Z", edgeGate("02:15", "03:30"))).toMatchObject({ ok: true, allowed: true, adjustedBoundaries: [{ requestedWallTime: "2026-03-08T02:15", resolvedWallTime: "2026-03-08T03:15" }] });
    expect(evaluateFocusGate(localCreate, "2026-03-08T08:30:00Z", edgeGate("01:30", "02:30"))).toMatchObject({ ok: true, allowed: false, adjustedBoundaries: [{ requestedWallTime: "2026-03-08T02:30", resolvedWallTime: "2026-03-08T03:30" }] });
    expect(evaluateFocusGate(localCreate, "2026-11-01T06:30:00Z", edgeGate("01:30", "02:00"))).toMatchObject({ ok: true, allowed: true });
    expect(evaluateFocusGate(localCreate, "2026-11-01T06:30:00Z", edgeGate("00:30", "01:30"))).toMatchObject({ ok: true, allowed: false, code: "focus-gate-closed" });
  });

  it("fails closed when compatible DST resolution inverts or overlaps a window", () => {
    const inverted = withWindows(
      { id: "inverted", startLocalTime: "02:15", endLocalTime: "03:00" },
      { id: "otherwise-open", startLocalTime: "03:10", endLocalTime: "03:40" },
    );
    const overlapping = withWindows(
      { id: "extended", startLocalTime: "01:45", endLocalTime: "02:15" },
      { id: "overlapped", startLocalTime: "03:00", endLocalTime: "03:30" },
    );
    expect(evaluateFocusGate(localCreate, "2026-03-08T08:20:00Z", inverted)).toMatchObject({ ok: false, error: { code: "dst-boundary-invalid" } });
    expect(evaluateFocusGate(localCreate, "2026-03-08T08:05:00Z", overlapping)).toMatchObject({ ok: false, error: { code: "dst-boundary-invalid" } });
  });

  it("returns stable results for repeated and permuted evaluation", () => {
    const reversed = { ...gate, windows: [...gate.windows].reverse() };
    const first = evaluateFocusGate(localCreate, "2026-07-23T14:30:00Z", gate);
    expect(evaluateFocusGate(localCreate, "2026-07-23T14:30:00Z", gate)).toEqual(first);
    expect(evaluateFocusGate(localCreate, "2026-07-23T14:30:00Z", reversed)).toEqual(first);
  });
});
