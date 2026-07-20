import { Temporal } from "@js-temporal/polyfill";

import { containsNow, resolveWallTime, type AdjustedBoundary, type WallTimeIntent } from "../time";

export type DailyFocusWindow = Readonly<{ id: string; startLocalTime: string; endLocalTime: string }>;
export type FocusGateConfig = Readonly<{ enabled: false }> | Readonly<{
  enabled: true;
  timeZone: string;
  windows: readonly DailyFocusWindow[];
}>;
export type ValidatedFocusGateConfig = Readonly<{ enabled: false }> | Readonly<{
  enabled: true;
  timeZone: string;
  windows: readonly [DailyFocusWindow, DailyFocusWindow];
}>;
export type FocusGateCommand =
  | Readonly<{ kind: "local-task-create" | "local-task-edit" | "local-task-complete"; taskSource: "local" | "github" | "linear" }>
  | Readonly<{ kind: "task-read" | "analysis" | "sync" }>
  | Readonly<{ kind: "focus-gate-revise" | "focus-gate-disable"; confirmed: boolean }>
  | Readonly<{ kind: "task-delete"; taskSource: "local" | "github" | "linear" }>
  | Readonly<{ kind: string }>;

type GateErrorCode = "invalid-focus-gate" | "invalid-zone" | "confirmation-required" | "unknown-command" | "invalid-instant" | "dst-boundary-invalid";
type GateFailure = Readonly<{ ok: false; error: Readonly<{ code: GateErrorCode; message: string }> }>;
type GateSuccess<T> = Readonly<{ ok: true } & T>;
export type FocusGateResult<T> = GateSuccess<T> | GateFailure;

const failure = (code: GateErrorCode, message: string): GateFailure => ({ ok: false, error: { code, message } });

export const validateFocusGate = (config: FocusGateConfig): FocusGateResult<{ value: ValidatedFocusGateConfig }> => {
  if (!config.enabled) return { ok: true, value: { enabled: false } };
  if (config.windows.length !== 2) return failure("invalid-focus-gate", "Focus Gate requires exactly two windows");
  const zone = resolveWallTime({ date: "2000-01-01", time: "00:00", timeZone: config.timeZone });
  if (!zone.ok) return failure(zone.error.code === "invalid-zone" ? "invalid-zone" : "invalid-focus-gate", "Focus Gate requires a valid IANA time zone");

  const [first, second] = config.windows;
  if (first.id === second.id) return failure("invalid-focus-gate", "Focus Gate window IDs must be unique");
  try {
    const windows = [first, second].map((window) => ({
      ...window,
      start: Temporal.PlainTime.from(window.startLocalTime),
      end: Temporal.PlainTime.from(window.endLocalTime),
    })).sort((a, b) => Temporal.PlainTime.compare(a.start, b.start));
    if (windows.some(({ start, end }) => Temporal.PlainTime.compare(start, end) >= 0 || start.until(end).total({ unit: "minutes" }) < 15)) {
      return failure("invalid-focus-gate", "Focus windows must be same-day and at least 15 minutes");
    }
    if (Temporal.PlainTime.compare(windows[0].start, windows[1].end) < 0 && Temporal.PlainTime.compare(windows[1].start, windows[0].end) < 0) {
      return failure("invalid-focus-gate", "Focus windows must not overlap");
    }
    return {
      ok: true,
      value: {
        enabled: true,
        timeZone: config.timeZone,
        windows: windows.map((window) => ({
          id: window.id,
          startLocalTime: window.startLocalTime,
          endLocalTime: window.endLocalTime,
        })) as [DailyFocusWindow, DailyFocusWindow],
      },
    };
  } catch {
    return failure("invalid-focus-gate", "Focus Gate windows require ISO local times");
  }
};

const localDate = (now: string, timeZone: string): string | GateFailure => {
  try {
    return Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate().toString();
  } catch {
    return failure("invalid-instant", "Expected an ISO-8601 instant");
  }
};

export const evaluateFocusGate = (
  command: FocusGateCommand,
  now: string,
  config: FocusGateConfig,
): FocusGateResult<{ allowed: boolean; code?: "focus-gate-closed" | "imported-task-immutable" | "task-deletion-not-supported"; adjustedBoundaries?: readonly AdjustedBoundary[] }> => {
  if (command.kind === "task-delete") return { ok: true, allowed: false, code: "task-deletion-not-supported" };
  if (command.kind === "task-read" || command.kind === "analysis" || command.kind === "sync") return { ok: true, allowed: true };
  if ((command.kind === "focus-gate-revise" || command.kind === "focus-gate-disable") && "confirmed" in command) {
    return command.confirmed ? { ok: true, allowed: true } : failure("confirmation-required", "Settings changes require confirmation");
  }
  if (!["local-task-create", "local-task-edit", "local-task-complete"].includes(command.kind) || !("taskSource" in command)) return failure("unknown-command", "Unknown Focus Gate command");
  if (command.taskSource !== "local") return { ok: true, allowed: false, code: "imported-task-immutable" };

  const valid = validateFocusGate(config);
  if (!valid.ok) return valid;
  if (!valid.value.enabled) return { ok: true, allowed: true };
  const { timeZone, windows } = valid.value;
  const date = localDate(now, timeZone);
  if (typeof date !== "string") return date;
  const boundaries = windows.flatMap((window) => [
    resolveWallTime({ date, time: window.startLocalTime, timeZone }),
    resolveWallTime({ date, time: window.endLocalTime, timeZone }),
  ]);
  if (boundaries.some((boundary) => !boundary.ok)) return failure("dst-boundary-invalid", "Could not resolve Focus Gate boundaries");
  const resolved = boundaries as Extract<typeof boundaries[number], { ok: true }>[];
  const decisions = [0, 2].map((index) => containsNow({ startAt: resolved[index].instant, endAt: resolved[index + 1].instant }, now));
  if (decisions.some((decision) => !decision.ok)) return failure("dst-boundary-invalid", "DST resolution produced an invalid Focus Gate window");
  if (Temporal.Instant.compare(resolved[0].instant, resolved[3].instant) < 0 && Temporal.Instant.compare(resolved[2].instant, resolved[1].instant) < 0) {
    return failure("dst-boundary-invalid", "DST resolution produced overlapping Focus Gate windows");
  }
  const isOpen = decisions.some((decision) => decision.ok && decision.contains);
  const adjustedBoundaries = resolved.flatMap((boundary) => boundary.adjustedBoundary ? [boundary.adjustedBoundary] : []);
  return { ok: true, allowed: isOpen, ...(isOpen ? {} : { code: "focus-gate-closed" }), ...(adjustedBoundaries.length ? { adjustedBoundaries } : {}) };
};

export const reviseFocusGate = (
  _current: FocusGateConfig,
  next: FocusGateConfig,
  confirmed: boolean,
): FocusGateResult<{ value: ValidatedFocusGateConfig }> => confirmed ? validateFocusGate(next) : failure("confirmation-required", "Settings changes require confirmation");

export const changeFocusGateTimeZone = (config: FocusGateConfig, timeZone: string): FocusGateResult<{ value: ValidatedFocusGateConfig }> => {
  if (!config.enabled) return { ok: true, value: config };
  const intent: WallTimeIntent = { date: "2000-01-01", time: "00:00", timeZone };
  if (!resolveWallTime(intent).ok) return failure("invalid-zone", "Focus Gate requires a valid IANA time zone");
  return validateFocusGate({ ...config, timeZone });
};
