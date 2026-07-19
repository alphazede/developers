import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

const MAX_STRING = 512;
const text = (max = MAX_STRING) => z.string().min(1).max(max);
const id = text(128).uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const schemaVersion = z.literal(1);
const instant = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T.*Z$/).superRefine((value, ctx) => {
  try { Temporal.Instant.from(value); } catch { ctx.addIssue({ code: "custom", message: "Expected an ISO-8601 UTC instant" }); }
});
const localDate = z.string().max(10).regex(/^\d{4}-\d{2}-\d{2}$/).superRefine((value, ctx) => {
  try { Temporal.PlainDate.from(value); } catch { ctx.addIssue({ code: "custom", message: "Expected an ISO local date" }); }
});
const localTime = z.string().max(18).superRefine((value, ctx) => {
  try { Temporal.PlainTime.from(value); } catch { ctx.addIssue({ code: "custom", message: "Expected an ISO local time" }); }
});
const timeZone = text(64).regex(/^[A-Za-z_+\-/]+$/).superRefine((value, ctx) => {
  try { Temporal.ZonedDateTime.from(`2000-01-01T00:00[${value}]`); } catch { ctx.addIssue({ code: "custom", message: "Expected an IANA time zone" }); }
});
const boundedRecord = <T extends z.ZodType>(value: T, max: number) =>
  z.record(text(128), value).superRefine((record, ctx) => {
    if (Object.keys(record).length > max) ctx.addIssue({ code: "custom", message: `Expected at most ${max} entries` });
  });

export const sourceSchema = z.enum(["local", "fixture", "google-calendar", "gmail", "github", "linear", "microsoft", "strava", "oura", "ics"]);
export const freshnessV1Schema = z.object({
  schemaVersion, fetchedAt: instant, sourceUpdatedAt: instant.nullable(), expiresAt: instant.nullable(),
  state: z.enum(["fresh", "stale", "revoked", "fixture"]),
}).strict();
export const provenanceV1Schema = z.object({
  schemaVersion, source: sourceSchema, sourceEntityId: text(256), consentRevision: z.number().int().nonnegative(),
  freshness: freshnessV1Schema, importedAt: instant,
}).strict();

export const normalizedTaskV1Schema = z.object({
  schemaVersion, id, source: z.enum(["local", "fixture", "github", "linear"]), sourceEntityId: text(256), title: text(), state: text(128),
  durationMinutes: z.number().int().positive().max(1_440).nullable(), deadlineAt: instant.nullable(), priority: z.number().int().min(0).max(100).nullable(),
  projectRef: text(256).nullable(), labels: z.array(text(128)).max(100), immutable: z.boolean(), provenance: provenanceV1Schema,
}).strict();
export const normalizedCommitmentV1Schema = z.object({
  schemaVersion, id, kind: z.enum(["calendar-event", "selected-email-commitment", "protected-time", "recovery-buffer"]), title: text(),
  startAt: instant.nullable(), endAt: instant.nullable(), deadlineAt: instant.nullable(), hard: z.boolean(), protected: z.boolean(),
  recurringSeriesRef: text(256).nullable(), participantSetKey: text(256).nullable(), provenance: provenanceV1Schema,
}).strict();
export const observationV1Schema = z.object({
  schemaVersion, id, observedAt: instant, localTime, value: z.number().finite(), reliability: z.number().min(0).max(1),
  signal: z.enum(["self-report", "task-outcome", "readiness", "activity", "meeting-after"]), provenance: provenanceV1Schema,
}).strict();
export const proposalV1Schema = z.object({
  schemaVersion, id, taskId: id, sourceRevision: z.number().int().nonnegative(), startAt: instant, endAt: instant, score: z.number().finite(),
  breakdown: z.object({ capacityFit: z.number().finite(), deadlineUrgency: z.number().finite(), goalAlignment: z.number().finite(), contextSwitch: z.number().finite(), recoverySupport: z.number().finite() }).strict(),
  confidence: z.number().min(0).max(1).nullable(), limitations: z.array(text()).max(100),
  status: z.enum(["preview", "approved", "effect-pending", "succeeded", "unknown", "rejected"]),
}).strict();
export const explanationPacketV1Schema = z.object({
  schemaVersion, proposalId: id, score: z.number().finite(),
  evidence: z.array(z.object({ kind: text(128), summary: text(), weight: z.number().finite(), freshness: freshnessV1Schema }).strict()).max(100),
  alternatives: z.array(z.object({ startAt: instant, endAt: instant, score: z.number().finite() }).strict()).max(3), limitations: z.array(text()).max(100), forbiddenAuthority: z.literal(true),
}).strict();
export const accessibleVisualizationV1Schema = z.object({
  schemaVersion, title: text(), summary: text(),
  series: z.array(z.object({ id, label: text(), points: z.array(z.object({ x: text(), y: z.number().finite().nullable() }).strict()).max(10_000) }).strict()).max(100),
  table: z.object({ columns: z.array(text()).max(100), rows: z.array(z.array(text()).max(100)).max(10_000) }).strict(), announcements: z.array(text()).max(100),
}).strict();

export const dailyFocusWindowV1Schema = z.object({ id, startLocalTime: localTime, endLocalTime: localTime }).strict();
const focusGateSchema = z.object({ enabled: z.literal(true), windows: z.tuple([dailyFocusWindowV1Schema, dailyFocusWindowV1Schema]) }).strict().superRefine(({ windows }, ctx) => {
  const ranges = windows.map((window) => ({ ...window, start: Temporal.PlainTime.from(window.startLocalTime), end: Temporal.PlainTime.from(window.endLocalTime) }));
  for (const range of ranges) if (Temporal.PlainTime.compare(range.end, range.start) <= 0 || range.start.until(range.end).total({ unit: "minutes" }) < 15) ctx.addIssue({ code: "custom", message: "Focus windows must be same-day and at least 15 minutes" });
  if (windows[0].id === windows[1].id || Temporal.PlainTime.compare(ranges[0].start, ranges[1].end) < 0 && Temporal.PlainTime.compare(ranges[1].start, ranges[0].end) < 0) ctx.addIssue({ code: "custom", message: "Focus windows must not overlap" });
});
export const fixtureManifestV1Schema = z.object({
  schemaVersion, persona: z.object({ id, displayName: z.literal("Jordan Lee"), timeZone: z.literal("America/Chicago") }).strict(),
  history: z.object({ startDate: localDate, endDate: localDate }).strict(), canonicalDay: localDate, fixedNow: instant,
  files: boundedRecord(z.object({ sha256: hash, count: z.number().int().nonnegative().max(10_000) }).strict(), 20), focusGate: focusGateSchema,
  expected: z.object({ stateSha256: hash, recommendationsSha256: hash }).strict(),
}).strict();

const event = <K extends string, T extends z.ZodType>(type: K, payload: T) => z.object({ schemaVersion, id, sequence: z.number().int().nonnegative(), occurredAt: instant, type: z.literal(type), commandId: id, payload }).strict();
export const domainEventV1Schema = z.discriminatedUnion("type", [
  event("ConsentChanged", z.object({ source: sourceSchema, consentRevision: z.number().int().nonnegative(), capabilities: z.array(text(128)).max(100), revoked: z.boolean() }).strict()),
  event("SourceSyncCompleted", z.object({ source: sourceSchema, normalizedIds: z.array(id).max(10_000), freshness: freshnessV1Schema }).strict()),
  event("SourceSyncFailed", z.object({ source: sourceSchema, code: text(128), retriable: z.boolean() }).strict()),
  event("ObservationRecorded", z.object({ observationId: id }).strict()),
  event("RecommendationComputed", z.object({ proposalIds: z.array(id).max(3), inputHash: hash }).strict()),
  event("ProposalApproved", z.object({ proposalId: id, approvalId: id }).strict()),
  event("EffectAttempted", z.object({ effectId: id, provider: z.literal("google-calendar") }).strict()),
  event("EffectSucceeded", z.object({ effectId: id, providerEntityId: text(256) }).strict()),
  event("EffectUnknown", z.object({ effectId: id, reason: z.enum(["timeout", "connection-lost", "malformed-response"]) }).strict()),
  event("FeedbackRecorded", z.object({ patternKeyHash: hash, disposition: z.enum(["confirm", "reject"]) }).strict()),
  event("PatternForgotten", z.object({ patternKeyHash: hash }).strict()),
  event("DataDeleted", z.object({ scope: z.enum(["source", "pattern", "profile"]), source: sourceSchema.nullable(), receiptId: id }).strict()),
]);
export const localStateV1Schema = z.object({
  schemaVersion, revision: z.number().int().nonnegative(), profileId: id, timeZone, connections: boundedRecord(z.object({ capabilities: z.array(text(128)).max(100), consentRevision: z.number().int().nonnegative(), freshness: freshnessV1Schema }).strict(), 20),
  tasks: z.array(normalizedTaskV1Schema).max(10_000), commitments: z.array(normalizedCommitmentV1Schema).max(2_000), observations: z.array(observationV1Schema).max(10_000), proposals: z.array(proposalV1Schema).max(10_000), events: z.array(domainEventV1Schema).max(10_000),
  commandReceipts: boundedRecord(z.object({ revision: z.number().int().nonnegative(), resultId: id }).strict(), 10_000),
}).strict();
export const tokenEnvelopeV1Schema = z.object({ schemaVersion, keyId: text(128), algorithm: z.literal("AES-256-GCM"), nonce: text(512), ciphertext: text(10_000), authTag: text(512), createdAt: instant }).strict();

export type Source = z.infer<typeof sourceSchema>;
export type FreshnessV1 = z.infer<typeof freshnessV1Schema>;
export type ProvenanceV1 = z.infer<typeof provenanceV1Schema>;
export type NormalizedTaskV1 = z.infer<typeof normalizedTaskV1Schema>;
export type NormalizedCommitmentV1 = z.infer<typeof normalizedCommitmentV1Schema>;
export type ObservationV1 = z.infer<typeof observationV1Schema>;
export type ProposalV1 = z.infer<typeof proposalV1Schema>;
export type ExplanationPacketV1 = z.infer<typeof explanationPacketV1Schema>;
export type AccessibleVisualizationV1 = z.infer<typeof accessibleVisualizationV1Schema>;
export type DailyFocusWindowV1 = z.infer<typeof dailyFocusWindowV1Schema>;
export type FixtureManifestV1 = z.infer<typeof fixtureManifestV1Schema>;
export type DomainEventV1 = z.infer<typeof domainEventV1Schema>;
export type LocalStateV1 = z.infer<typeof localStateV1Schema>;
export type TokenEnvelopeV1 = z.infer<typeof tokenEnvelopeV1Schema>;
