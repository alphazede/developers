import { Temporal } from "@js-temporal/polyfill";

import type { ConnectorManifest, ConnectorSource } from "../../application/connectors";
import { normalizedCommitmentV1Schema, observationV1Schema, type NormalizedCommitmentV1, type ObservationV1 } from "../../contracts/v1";
import { uuidV5 } from "../../domain/schedule";
import {
  AdapterBoundaryError, MAX_PROVIDER_BYTES, MAX_PROVIDER_PAGES, MAX_PROVIDER_RECORDS,
  MAX_PROVIDER_RECORDS_PER_PAGE, boundedProviderText, exactObject,
} from "../shared";

type FixtureSource = "microsoft" | "strava" | "oura";
type FixtureCapability = "calendar.fixture.read" | "activity.fixture.read" | "readiness.fixture.read";
type FixtureEnvelope = Readonly<{
  schemaVersion: 1; source: FixtureSource; capability: FixtureCapability; consentRevision: number; fetchedAt: string;
  pages: readonly Readonly<{ records: readonly unknown[] }>[];
}>;
type MicrosoftRecord = Readonly<{ schemaVersion: 1; id: string; title: string; startAt: string; endAt: string; updatedAt: string; protected: boolean }>;
type ObservationRecord = Readonly<{ schemaVersion: 1; id: string; observedAt: string; localTime: string; value: number; reliability: number; updatedAt: string }>;

const definitions: Record<FixtureSource, FixtureCapability> = {
  microsoft: "calendar.fixture.read", strava: "activity.fixture.read", oura: "readiness.fixture.read",
};
const canonicalInstant = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  try { return Temporal.Instant.from(value).toString() === value; } catch { return false; }
};
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fail = (source: ConnectorSource, code: "MALFORMED_SOURCE" | "OVERSIZED_SOURCE" | "UNSUPPORTED_CONTRACT"): never => { throw new AdapterBoundaryError(source, code); };
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

const envelope = (value: unknown, source: FixtureSource): FixtureEnvelope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(source, "MALFORMED_SOURCE");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return fail(source, "UNSUPPORTED_CONTRACT");
  if (!exactObject(raw, ["schemaVersion", "source", "capability", "consentRevision", "fetchedAt", "pages"])
    || raw.source !== source || raw.capability !== definitions[source] || !safe(raw.consentRevision) || !canonicalInstant(raw.fetchedAt)
    || !Array.isArray(raw.pages) || raw.pages.length > MAX_PROVIDER_PAGES || Buffer.byteLength(JSON.stringify(raw)) > MAX_PROVIDER_BYTES) return fail(source, "MALFORMED_SOURCE");
  let total = 0;
  for (const page of raw.pages) {
    if (!exactObject(page, ["records"]) || !Array.isArray(page.records) || page.records.length > MAX_PROVIDER_RECORDS_PER_PAGE) return fail(source, "MALFORMED_SOURCE");
    total += page.records.length;
    if (total > MAX_PROVIDER_RECORDS) return fail(source, "OVERSIZED_SOURCE");
  }
  return raw as unknown as FixtureEnvelope;
};

const freshness = (fetchedAt: string, sourceUpdatedAt: string) => ({
  schemaVersion: 1 as const, fetchedAt, sourceUpdatedAt, expiresAt: null, state: "fixture" as const,
});

export const fixtureStatus = (source: FixtureSource, fetchedAt: string, consentRevision: number): Readonly<{
  schemaVersion: 1; source: FixtureSource; status: "fixture"; mode: "fixture"; liveAvailable: false; capabilities: readonly FixtureCapability[]; manifest: ConnectorManifest;
}> => {
  if (!definitions[source] || !canonicalInstant(fetchedAt) || !safe(consentRevision)) return fail(source, "MALFORMED_SOURCE");
  const capabilities = [definitions[source]] as const;
  return freeze({
    schemaVersion: 1, source, status: "fixture", mode: "fixture", liveAvailable: false, capabilities,
    manifest: { schemaVersion: 1, source, capabilities, consentRevision, freshness: freshness(fetchedAt, fetchedAt), mode: "fixture" },
  });
};

const microsoftRecord = (value: unknown): MicrosoftRecord => {
  if (!exactObject(value, ["schemaVersion", "id", "title", "startAt", "endAt", "updatedAt", "protected"])) return fail("microsoft", "MALFORMED_SOURCE");
  if (value.schemaVersion !== 1 || !boundedProviderText(value.id, 256) || !boundedProviderText(value.title)
    || !canonicalInstant(value.startAt) || !canonicalInstant(value.endAt) || Temporal.Instant.compare(value.startAt, value.endAt) >= 0
    || !canonicalInstant(value.updatedAt) || typeof value.protected !== "boolean") return fail("microsoft", "MALFORMED_SOURCE");
  return value as unknown as MicrosoftRecord;
};

export const normalizeMicrosoftFixture = async (value: unknown): Promise<readonly NormalizedCommitmentV1[]> => {
  const input = envelope(value, "microsoft"), seen = new Set<string>(), records: MicrosoftRecord[] = [];
  for (const raw of input.pages.flatMap((page) => page.records)) {
    const record = microsoftRecord(raw);
    if (seen.has(record.id) || Temporal.Instant.compare(record.updatedAt, input.fetchedAt) > 0) return fail("microsoft", "MALFORMED_SOURCE");
    seen.add(record.id); records.push(record);
  }
  records.sort((a, b) => Temporal.Instant.compare(a.startAt, b.startAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const values = await Promise.all(records.map(async (record) => {
    const parsed = normalizedCommitmentV1Schema.safeParse({
      schemaVersion: 1, id: await uuidV5(["urn:capacity-scheduling:microsoft-fixture:v1", record.id]), kind: "calendar-event",
      title: record.title, startAt: record.startAt, endAt: record.endAt, deadlineAt: null, hard: true, protected: record.protected,
      recurringSeriesRef: null, participantSetKey: null,
      provenance: { schemaVersion: 1, source: "microsoft", sourceEntityId: record.id, consentRevision: input.consentRevision, freshness: freshness(input.fetchedAt, record.updatedAt), importedAt: input.fetchedAt },
    });
    if (!parsed.success) return fail("microsoft", "MALFORMED_SOURCE");
    return parsed.data;
  }));
  return freeze(values);
};

const observationRecord = (value: unknown, source: "strava" | "oura"): ObservationRecord => {
  if (!exactObject(value, ["schemaVersion", "id", "observedAt", "localTime", "value", "reliability", "updatedAt"])) return fail(source, "MALFORMED_SOURCE");
  if (value.schemaVersion !== 1 || !boundedProviderText(value.id, 256) || !canonicalInstant(value.observedAt) || !canonicalInstant(value.updatedAt)
    || typeof value.localTime !== "string" || typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < -1 || value.value > 1
    || typeof value.reliability !== "number" || !Number.isFinite(value.reliability) || value.reliability < 0 || value.reliability > 1) return fail(source, "MALFORMED_SOURCE");
  return value as unknown as ObservationRecord;
};

const normalizeObservationFixture = async (value: unknown, source: "strava" | "oura"): Promise<readonly ObservationV1[]> => {
  const input = envelope(value, source), seen = new Set<string>(), records: ObservationRecord[] = [];
  for (const raw of input.pages.flatMap((page) => page.records)) {
    const record = observationRecord(raw, source);
    if (seen.has(record.id) || Temporal.Instant.compare(record.observedAt, input.fetchedAt) > 0 || Temporal.Instant.compare(record.updatedAt, input.fetchedAt) > 0) return fail(source, "MALFORMED_SOURCE");
    seen.add(record.id); records.push(record);
  }
  records.sort((a, b) => Temporal.Instant.compare(a.observedAt, b.observedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const signal = source === "strava" ? "activity" as const : "readiness" as const;
  const values = await Promise.all(records.map(async (record) => {
    const parsed = observationV1Schema.safeParse({
      schemaVersion: 1, id: await uuidV5([`urn:capacity-scheduling:${source}-fixture:v1`, record.id]), observedAt: record.observedAt,
      localTime: record.localTime, value: record.value, reliability: record.reliability, signal,
      provenance: { schemaVersion: 1, source, sourceEntityId: record.id, consentRevision: input.consentRevision, freshness: freshness(input.fetchedAt, record.updatedAt), importedAt: input.fetchedAt },
    });
    if (!parsed.success) return fail(source, "MALFORMED_SOURCE");
    return parsed.data;
  }));
  return freeze(values);
};

export const normalizeStravaFixture = (value: unknown) => normalizeObservationFixture(value, "strava");
export const normalizeOuraFixture = (value: unknown) => normalizeObservationFixture(value, "oura");

export class MicrosoftFixtureAdapter { readonly status = "fixture" as const; normalize(value: unknown) { return normalizeMicrosoftFixture(value); } }
export class StravaFixtureAdapter { readonly status = "fixture" as const; normalize(value: unknown) { return normalizeStravaFixture(value); } }
export class OuraFixtureAdapter { readonly status = "fixture" as const; normalize(value: unknown) { return normalizeOuraFixture(value); } }
