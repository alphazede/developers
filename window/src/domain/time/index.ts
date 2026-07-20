import { Temporal } from "@js-temporal/polyfill";

export type WallTimeIntent = Readonly<{ date: string; time: string; timeZone: string }>;

type TimeErrorCode = "invalid-zone" | "invalid-wall-time" | "invalid-instant" | "invalid-boundary" | "dst-resolution-failed";
type TimeError = Readonly<{ code: TimeErrorCode; message: string }>;
type Failure = Readonly<{ ok: false; error: TimeError }>;

export type AdjustedBoundary = Readonly<{ requestedWallTime: string; resolvedWallTime: string }>;

export type ResolvedWallTime = Readonly<{
  ok: true;
  instant: string;
  timeZone: string;
  wallTime: string;
  adjustedBoundary?: AdjustedBoundary;
}>;

export type TimeResult<T> = Readonly<{ ok: true } & T> | Failure;

const failure = (code: TimeErrorCode, message: string): Failure => ({ ok: false, error: { code, message } });

const validateZone = (timeZone: string): Failure | undefined => {
  try {
    const zone = Temporal.ZonedDateTime.from(`2000-01-01T00:00[${timeZone}]`).timeZoneId;
    if (/^[+-]/.test(zone)) return failure("invalid-zone", "Expected an IANA time zone");
  } catch {
    return failure("invalid-zone", "Expected an IANA time zone");
  }
};

const parseCanonicalInstant = (value: string): Temporal.Instant => {
  if (!value.endsWith("Z")) throw new RangeError("Expected a UTC-Z instant");
  const instant = Temporal.Instant.from(value);
  if (instant.toString() !== value) throw new RangeError("Expected a canonical UTC-Z instant");
  return instant;
};

export const resolveWallTime = (intent: WallTimeIntent): ResolvedWallTime | Failure => {
  const zoneError = validateZone(intent.timeZone);
  if (zoneError) return zoneError;

  const requestedWallTime = `${intent.date}T${intent.time}`;
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(requestedWallTime);
  } catch {
    return failure("invalid-wall-time", "Expected an ISO local date and time");
  }

  try {
    const resolved = plain.toZonedDateTime(intent.timeZone, { disambiguation: "compatible" });
    const resolvedPlain = resolved.toPlainDateTime();
    const resolvedWallTime = resolvedPlain.toString({ smallestUnit: "minute" });
    const adjustedBoundary = Temporal.PlainDateTime.compare(resolvedPlain, plain) === 0
      ? undefined
      : { requestedWallTime, resolvedWallTime };
    return {
      ok: true,
      instant: resolved.toInstant().toString(),
      timeZone: intent.timeZone,
      wallTime: requestedWallTime,
      ...(adjustedBoundary ? { adjustedBoundary } : {}),
    };
  } catch {
    return failure("dst-resolution-failed", "Could not resolve the wall time");
  }
};

export const containsNow = (
  bounds: Readonly<{ startAt: string; endAt: string }>,
  now: string,
): TimeResult<{ contains: boolean }> => {
  try {
    const start = parseCanonicalInstant(bounds.startAt);
    const end = parseCanonicalInstant(bounds.endAt);
    const instant = parseCanonicalInstant(now);
    if (Temporal.Instant.compare(start, end) >= 0) return failure("invalid-boundary", "Expected startAt before endAt");
    return {
      ok: true,
      contains: Temporal.Instant.compare(instant, start) >= 0 && Temporal.Instant.compare(instant, end) < 0,
    };
  } catch {
    return failure("invalid-instant", "Expected ISO-8601 instants");
  }
};

export const changeTimeZone = (intent: WallTimeIntent, timeZone: string): TimeResult<{ value: WallTimeIntent }> => {
  const original = resolveWallTime(intent);
  if (!original.ok) return original;
  const zoneError = validateZone(timeZone);
  return zoneError ?? { ok: true, value: { date: intent.date, time: intent.time, timeZone } };
};
