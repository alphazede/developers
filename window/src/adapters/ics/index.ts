import { createHash } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";

import { normalizedCommitmentV1Schema, type NormalizedCommitmentV1 } from "../../contracts/v1";
import { uuidV5 } from "../../domain/schedule";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 2_000;
const MAX_LINES = 10_000;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_DEPTH = 4;
const MAX_OCCURRENCES = 366;
const SINGLETONS = new Set(["UID", "DTSTART", "DTEND", "SUMMARY", "STATUS", "RRULE", "RECURRENCE-ID"]);

export type IcsErrorCode =
  | "INVALID_UTF8" | "OVERSIZED_SOURCE" | "MALFORMED_CALENDAR" | "UNSUPPORTED_VERSION"
  | "DUPLICATE_PROPERTY" | "DUPLICATE_EVENT" | "UNSUPPORTED_COMPONENT" | "UNSUPPORTED_TIME"
  | "UNKNOWN_TIME_ZONE" | "AMBIGUOUS_WALL_TIME" | "NONEXISTENT_WALL_TIME"
  | "UNSUPPORTED_RECURRENCE" | "UNBOUNDED_RECURRENCE" | "INVALID_APPROVAL" | "INVALID_EXPORT";

export class IcsBoundaryError extends Error {
  constructor(readonly code: IcsErrorCode) { super(code); this.name = "IcsBoundaryError"; }
}

const fail = (code: IcsErrorCode): never => { throw new IcsBoundaryError(code); };
const bytes = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const canonicalInstant = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  try { return Temporal.Instant.from(value).toString() === value; } catch { return false; }
};
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

type RawProperty = { value: string; params: Readonly<Record<string, string>> };
type RawEvent = { properties: Map<string, RawProperty>; order: number };

const unfold = (input: Uint8Array): string[] => {
  if (!(input instanceof Uint8Array)) return fail("MALFORMED_CALENDAR");
  if (input.byteLength > MAX_BYTES) return fail("OVERSIZED_SOURCE");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch { return fail("INVALID_UTF8"); }
  if (!text || /\r(?!\n)/.test(text) || !/(?:\r\n|\n)$/.test(text)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return fail("MALFORMED_CALENDAR");
  const physical = text.replace(/\r\n/g, "\n").split("\n");
  physical.pop();
  const lines: string[] = [];
  for (const line of physical) {
    if (line.includes("\t") && !line.startsWith("\t")) return fail("MALFORMED_CALENDAR");
    if (/^[ \t]/.test(line)) {
      if (!lines.length || line.length === 1) return fail("MALFORMED_CALENDAR");
      lines[lines.length - 1] += line.slice(1);
    } else {
      if (!line) return fail("MALFORMED_CALENDAR");
      lines.push(line);
      if (lines.length > MAX_LINES) return fail("OVERSIZED_SOURCE");
    }
    if (Buffer.byteLength(lines.at(-1)!) > MAX_LINE_BYTES) return fail("OVERSIZED_SOURCE");
  }
  return lines;
};

const property = (line: string): { name: string; property: RawProperty } => {
  const split = line.indexOf(":");
  if (split < 1) return fail("MALFORMED_CALENDAR");
  const [namePart, ...parameterParts] = line.slice(0, split).split(";");
  const name = namePart!.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return fail("MALFORMED_CALENDAR");
  const params: Record<string, string> = {};
  for (const raw of parameterParts) {
    const equals = raw.indexOf("=");
    if (equals < 1) return fail("MALFORMED_CALENDAR");
    const key = raw.slice(0, equals).toUpperCase(), value = raw.slice(equals + 1);
    if (!/^[A-Z0-9-]+$/.test(key) || !value || key in params || /["\r\n]/.test(value)) return fail("MALFORMED_CALENDAR");
    params[key] = value;
  }
  return { name, property: { value: line.slice(split + 1), params } };
};

const parseCalendar = (lines: readonly string[]): RawEvent[] => {
  const stack: string[] = [];
  const events: RawEvent[] = [];
  let calendarCount = 0, versionCount = 0, current: RawEvent | undefined;
  for (const line of lines) {
    const parsed = property(line);
    if (parsed.name === "BEGIN") {
      const component = parsed.property.value.toUpperCase();
      if (!/^[A-Z0-9-]+$/.test(component) || stack.length >= MAX_DEPTH) return fail("MALFORMED_CALENDAR");
      if (component === "VCALENDAR") {
        if (stack.length || calendarCount++) return fail("MALFORMED_CALENDAR");
      } else if (component === "VEVENT") {
        if (stack.length !== 1 || stack[0] !== "VCALENDAR" || current) return fail("MALFORMED_CALENDAR");
        if (events.length >= MAX_EVENTS) return fail("OVERSIZED_SOURCE");
        current = { properties: new Map(), order: events.length };
      } else return fail("UNSUPPORTED_COMPONENT");
      stack.push(component);
      continue;
    }
    if (parsed.name === "END") {
      const component = parsed.property.value.toUpperCase();
      if (stack.pop() !== component) return fail("MALFORMED_CALENDAR");
      if (component === "VEVENT") { if (!current) return fail("MALFORMED_CALENDAR"); events.push(current); current = undefined; }
      continue;
    }
    if (!stack.length) return fail("MALFORMED_CALENDAR");
    if (current) {
      if (parsed.name === "EXRULE") return fail("UNSUPPORTED_RECURRENCE");
      if (SINGLETONS.has(parsed.name) && current.properties.has(parsed.name)) return fail("DUPLICATE_PROPERTY");
      if (SINGLETONS.has(parsed.name)) current.properties.set(parsed.name, parsed.property);
    } else if (stack.length === 1 && parsed.name === "VERSION") {
      if (versionCount++) return fail("DUPLICATE_PROPERTY");
      if (parsed.property.value !== "2.0") return fail("UNSUPPORTED_VERSION");
    }
  }
  if (stack.length || current || calendarCount !== 1 || versionCount !== 1 || lines.at(-1) !== "END:VCALENDAR") return fail("MALFORMED_CALENDAR");
  return events;
};

const unescapeText = (value: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") { result += value[index]; continue; }
    const escaped = value[++index];
    if (escaped === "n" || escaped === "N") result += "\n";
    else if (escaped === "\\" || escaped === "," || escaped === ";") result += escaped;
    else return fail("MALFORMED_CALENDAR");
  }
  if (!result || Buffer.byteLength(result) > 512) return fail("MALFORMED_CALENDAR");
  return result;
};

type DateValue = { instant: Temporal.Instant; kind: "date" | "utc" | "zoned"; timeZone: string | null; source: string };
const localInstant = (plain: Temporal.PlainDateTime, timeZone: string): Temporal.Instant => {
  try {
    const zone = Temporal.ZonedDateTime.from(`2000-01-01T00:00[${timeZone}]`).timeZoneId;
    if (zone !== timeZone || /^[+-]/.test(zone)) return fail("UNKNOWN_TIME_ZONE");
  } catch { return fail("UNKNOWN_TIME_ZONE"); }
  const earlier = plain.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  const later = plain.toZonedDateTime(timeZone, { disambiguation: "later" });
  if (Temporal.Instant.compare(earlier.toInstant(), later.toInstant()) !== 0) {
    const earlierMatches = Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), plain) === 0;
    const laterMatches = Temporal.PlainDateTime.compare(later.toPlainDateTime(), plain) === 0;
    return fail(earlierMatches && laterMatches ? "AMBIGUOUS_WALL_TIME" : "NONEXISTENT_WALL_TIME");
  }
  return earlier.toInstant();
};

const dateValue = (raw: RawProperty): DateValue => {
  const keys = Object.keys(raw.params);
  if (keys.some((key) => key !== "VALUE" && key !== "TZID")) return fail("UNSUPPORTED_TIME");
  if (raw.params.VALUE === "DATE") {
    if (raw.params.TZID || !/^\d{8}$/.test(raw.value)) return fail("UNSUPPORTED_TIME");
    try {
      const date = Temporal.PlainDate.from(`${raw.value.slice(0, 4)}-${raw.value.slice(4, 6)}-${raw.value.slice(6, 8)}`);
      return { instant: date.toZonedDateTime("UTC").toInstant(), kind: "date", timeZone: null, source: raw.value };
    } catch { return fail("UNSUPPORTED_TIME"); }
  }
  if (raw.params.VALUE !== undefined && raw.params.VALUE !== "DATE-TIME") return fail("UNSUPPORTED_TIME");
  if (/^\d{8}T\d{6}Z$/.test(raw.value)) {
    if (raw.params.TZID) return fail("UNSUPPORTED_TIME");
    try {
      const iso = `${raw.value.slice(0, 4)}-${raw.value.slice(4, 6)}-${raw.value.slice(6, 8)}T${raw.value.slice(9, 11)}:${raw.value.slice(11, 13)}:${raw.value.slice(13, 15)}Z`;
      return { instant: Temporal.Instant.from(iso), kind: "utc", timeZone: null, source: raw.value };
    } catch { return fail("UNSUPPORTED_TIME"); }
  }
  if (!/^\d{8}T\d{6}$/.test(raw.value)) return fail("UNSUPPORTED_TIME");
  if (!raw.params.TZID) return fail("UNSUPPORTED_TIME");
  try {
    const plain = Temporal.PlainDateTime.from(`${raw.value.slice(0, 4)}-${raw.value.slice(4, 6)}-${raw.value.slice(6, 8)}T${raw.value.slice(9, 11)}:${raw.value.slice(11, 13)}:${raw.value.slice(13, 15)}`);
    return { instant: localInstant(plain, raw.params.TZID), kind: "zoned", timeZone: raw.params.TZID, source: raw.value };
  } catch (error) { if (error instanceof IcsBoundaryError) throw error; return fail("UNSUPPORTED_TIME"); }
};

type ParsedEvent = { uid: string; recurrenceId: string | null; start: DateValue; end: DateValue; summary: string; status: "CONFIRMED" | "TENTATIVE" | "CANCELLED"; rrule: string | null };
const parsedEvent = (raw: RawEvent): ParsedEvent => {
  const get = (name: string, required = false) => {
    const value = raw.properties.get(name);
    if (required && !value) return fail("MALFORMED_CALENDAR");
    return value;
  };
  const uidRaw = get("UID", true)!, startRaw = get("DTSTART", true)!, endRaw = get("DTEND", true)!, summaryRaw = get("SUMMARY", true)!;
  if (Object.keys(uidRaw.params).length || Object.keys(summaryRaw.params).length || !uidRaw.value || Buffer.byteLength(uidRaw.value) > 512) return fail("MALFORMED_CALENDAR");
  const start = dateValue(startRaw), end = dateValue(endRaw);
  if (start.kind !== end.kind || start.timeZone !== end.timeZone || Temporal.Instant.compare(start.instant, end.instant) >= 0) return fail("UNSUPPORTED_TIME");
  const statusRaw = get("STATUS"), status = (statusRaw?.value ?? "CONFIRMED").toUpperCase();
  if (statusRaw && Object.keys(statusRaw.params).length || !["CONFIRMED", "TENTATIVE", "CANCELLED"].includes(status)) return fail("MALFORMED_CALENDAR");
  const recurrenceRaw = get("RECURRENCE-ID"), recurrence = recurrenceRaw ? dateValue(recurrenceRaw) : null;
  if (recurrence && (recurrence.kind !== start.kind || recurrence.timeZone !== start.timeZone)) return fail("UNSUPPORTED_TIME");
  const rruleRaw = get("RRULE");
  if (rruleRaw && Object.keys(rruleRaw.params).length || recurrence && rruleRaw) return fail("UNSUPPORTED_RECURRENCE");
  return { uid: uidRaw.value, recurrenceId: recurrence?.instant.toString() ?? null, start, end, summary: unescapeText(summaryRaw.value), status: status as ParsedEvent["status"], rrule: rruleRaw?.value ?? null };
};

type Rule = { frequency: "DAILY" | "WEEKLY"; interval: number; count: number | null; until: Temporal.Instant | null };
const rule = (value: string, event: ParsedEvent): Rule => {
  const parts = value.split(";");
  const fields = new Map<string, string>();
  for (const part of parts) {
    const split = part.indexOf("="); if (split < 1) return fail("UNSUPPORTED_RECURRENCE");
    const key = part.slice(0, split).toUpperCase(), item = part.slice(split + 1).toUpperCase();
    if (!item || fields.has(key) || key.startsWith("BY") || !["FREQ", "INTERVAL", "COUNT", "UNTIL"].includes(key)) return fail("UNSUPPORTED_RECURRENCE");
    fields.set(key, item);
  }
  const frequency = fields.get("FREQ");
  if (frequency !== "DAILY" && frequency !== "WEEKLY") return fail("UNSUPPORTED_RECURRENCE");
  if (!fields.has("COUNT") && !fields.has("UNTIL") || fields.has("COUNT") && fields.has("UNTIL")) return fail("UNBOUNDED_RECURRENCE");
  const intervalRaw = fields.get("INTERVAL") ?? "1", interval = Number(intervalRaw);
  if (!/^\d+$/.test(intervalRaw) || !Number.isSafeInteger(interval) || interval < 1 || interval > MAX_OCCURRENCES) return fail("UNSUPPORTED_RECURRENCE");
  let count: number | null = null;
  if (fields.has("COUNT")) {
    const raw = fields.get("COUNT")!, parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_OCCURRENCES) return fail("UNBOUNDED_RECURRENCE");
    count = parsed;
  }
  let until: Temporal.Instant | null = null;
  if (fields.has("UNTIL")) {
    const raw = fields.get("UNTIL")!;
    if (event.start.kind === "date") until = dateValue({ value: raw, params: { VALUE: "DATE" } }).instant;
    else until = dateValue({ value: raw, params: {} }).instant;
  }
  const horizon = event.start.instant.add({ hours: 24 * 366 });
  if (until && (Temporal.Instant.compare(until, event.start.instant) < 0 || Temporal.Instant.compare(until, horizon) > 0)) return fail("UNBOUNDED_RECURRENCE");
  return { frequency, interval, count, until };
};

const occurrenceStart = (event: ParsedEvent, ruleValue: Rule, index: number): Temporal.Instant => {
  const days = index * ruleValue.interval * (ruleValue.frequency === "WEEKLY" ? 7 : 1);
  if (event.start.kind === "zoned") return event.start.instant.toZonedDateTimeISO(event.start.timeZone!).add({ days }).toInstant();
  return event.start.instant.add({ hours: days * 24 });
};

export type IcsPreviewItem = Readonly<{
  uid: string; recurrenceId: string | null; status: "confirmed" | "tentative";
  commitment: NormalizedCommitmentV1;
}>;
export type IcsPreview = Readonly<{ schemaVersion: 1; previewOnly: true; previewHash: string; events: readonly IcsPreviewItem[] }>;
export type IcsPreviewInput = Readonly<{ consentRevision: number; fetchedAt: string }>;

export const parsePreview = async (source: Uint8Array, input: IcsPreviewInput): Promise<IcsPreview> => {
  if (!Number.isSafeInteger(input?.consentRevision) || input.consentRevision < 0 || !canonicalInstant(input.fetchedAt)) return fail("MALFORMED_CALENDAR");
  const rawEvents = parseCalendar(unfold(source)).map(parsedEvent);
  const identities = new Set<string>();
  for (const event of rawEvents) {
    const identity = `${event.uid}\0${event.recurrenceId ?? "master"}`;
    if (identities.has(identity)) return fail("DUPLICATE_EVENT"); identities.add(identity);
  }
  const grouped = new Map<string, ParsedEvent[]>();
  for (const event of rawEvents) grouped.set(event.uid, [...(grouped.get(event.uid) ?? []), event]);
  const expanded: Array<{ event: ParsedEvent; occurrenceId: string | null; start: Temporal.Instant; end: Temporal.Instant; recurring: boolean }> = [];
  for (const group of grouped.values()) {
    const masters = group.filter((event) => event.recurrenceId === null), exceptions = new Map(group.filter((event) => event.recurrenceId !== null).map((event) => [event.recurrenceId!, event]));
    if (masters.length !== 1) return fail("DUPLICATE_EVENT");
    const master = masters[0]!, duration = master.start.instant.until(master.end.instant).total({ unit: "nanoseconds" });
    if (!master.rrule) {
      if (exceptions.size) return fail("UNSUPPORTED_RECURRENCE");
      if (master.status !== "CANCELLED") expanded.push({ event: master, occurrenceId: null, start: master.start.instant, end: master.end.instant, recurring: false });
      continue;
    }
    const recurrence = rule(master.rrule, master);
    const horizon = master.start.instant.add({ hours: 24 * 366 });
    for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
      if (recurrence.count !== null && index >= recurrence.count) break;
      const start = occurrenceStart(master, recurrence, index);
      if (Temporal.Instant.compare(start, horizon) > 0) break;
      if (recurrence.until && Temporal.Instant.compare(start, recurrence.until) > 0) break;
      const recurrenceId = start.toString(), exception = exceptions.get(recurrenceId);
      if (exception) { exceptions.delete(recurrenceId); if (exception.status !== "CANCELLED") expanded.push({ event: exception, occurrenceId: recurrenceId, start: exception.start.instant, end: exception.end.instant, recurring: true }); }
      else if (master.status !== "CANCELLED") expanded.push({ event: master, occurrenceId: recurrenceId, start, end: start.add({ nanoseconds: duration }), recurring: true });
      if (expanded.length > MAX_EVENTS) return fail("OVERSIZED_SOURCE");
    }
    if (exceptions.size) return fail("UNSUPPORTED_RECURRENCE");
  }
  expanded.sort((a, b) => Temporal.Instant.compare(a.start, b.start) || bytes(a.event.uid, b.event.uid) || bytes(a.occurrenceId ?? "", b.occurrenceId ?? ""));
  const events = await Promise.all(expanded.map(async ({ event, occurrenceId, start, end, recurring }): Promise<IcsPreviewItem> => {
    const sourceEntityId = occurrenceId === null ? event.uid : `${event.uid}#${occurrenceId}`;
    const sourceFreshness = { schemaVersion: 1 as const, fetchedAt: input.fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" as const };
    const commitment = normalizedCommitmentV1Schema.parse({
      schemaVersion: 1, id: await uuidV5(["urn:capacity-scheduling:ics:v1", event.uid, occurrenceId ?? "master"]), kind: "calendar-event",
      title: event.summary, startAt: start.toString(), endAt: end.toString(), deadlineAt: null, hard: true, protected: false,
      recurringSeriesRef: recurring ? event.uid : null, participantSetKey: null,
      provenance: { schemaVersion: 1, source: "ics", sourceEntityId, consentRevision: input.consentRevision, freshness: sourceFreshness, importedAt: input.fetchedAt },
    });
    return { uid: event.uid, recurrenceId: occurrenceId, status: event.status === "TENTATIVE" ? "tentative" : "confirmed", commitment };
  }));
  const previewHash = createHash("sha256").update(JSON.stringify(events)).digest("hex");
  return deepFreeze({ schemaVersion: 1, previewOnly: true, previewHash, events });
};

export type ApprovedLocalScheduleItem = Readonly<{ id: string; source: "local"; approved: true; title: string; startAt: string; endAt: string }>;
const escapeText = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const utcValue = (value: string) => value.replace(/[-:]/g, "").replace(".000Z", "Z");
const foldLine = (line: string): string[] => {
  const folded: string[] = [];
  let current = "", limit = 75;
  for (const character of line) {
    if (Buffer.byteLength(current + character) > limit) {
      if (!current) return fail("INVALID_EXPORT");
      folded.push(`${folded.length ? " " : ""}${current}`); current = character; limit = 74;
    } else current += character;
  }
  folded.push(`${folded.length ? " " : ""}${current}`);
  return folded;
};

export const exportApproved = (items: readonly ApprovedLocalScheduleItem[]): string => {
  if (!Array.isArray(items) || items.length > MAX_EVENTS) return fail("INVALID_EXPORT");
  const seen = new Set<string>();
  const checked = items.map((item) => {
    if (!item || Object.keys(item).sort().join() !== "approved,endAt,id,source,startAt,title" || item.source !== "local" || item.approved !== true
      || typeof item.id !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.id) || seen.has(item.id) || typeof item.title !== "string" || !item.title
      || Buffer.byteLength(item.title) > 512 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(item.title)
      || !canonicalInstant(item.startAt) || !canonicalInstant(item.endAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item.startAt)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item.endAt) || Temporal.Instant.compare(item.startAt, item.endAt) >= 0) return fail("INVALID_EXPORT");
    seen.add(item.id); return item;
  }).sort((a, b) => Temporal.Instant.compare(a.startAt, b.startAt) || bytes(a.id, b.id));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Capacity Scheduling//Approved Export//EN", "CALSCALE:GREGORIAN"];
  for (const item of checked) lines.push(
    "BEGIN:VEVENT", `UID:${item.id}@capacity-scheduling.local`, `DTSTAMP:${utcValue(item.startAt)}`,
    `DTSTART:${utcValue(item.startAt)}`, `DTEND:${utcValue(item.endAt)}`, `SUMMARY:${escapeText(item.title)}`, "STATUS:CONFIRMED", "END:VEVENT",
  );
  lines.push("END:VCALENDAR");
  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
};
