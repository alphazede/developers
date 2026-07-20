import { Temporal } from "@js-temporal/polyfill";

import type {
  NormalizedCommitmentV1, NormalizedTaskV1, ObservationV1, ProposalV1, SchedulingIntentV1, Source,
} from "../../contracts/v1";
import type { ConnectorManifest, ConnectorSource } from "../connectors";

export type PrivacyEvidenceV1 = { id: string; source: Source; patternRef: string | null; summary: string; createdAt: string; pinned: boolean };
type ProposalReceiptV1 =
  | { id: string; source: "local"; taskId: string | null; createdAt: string; summary: string }
  | { id: string; source: "fixture" | "github" | "linear"; taskId: string; createdAt: string; summary: string };
export type PrivacyStateV1 = {
  schemaVersion: 1; revision: number; profileId: string; timeZone: string; profileDeleted: boolean;
  connectors: ConnectorManifest[]; tasks: NormalizedTaskV1[]; schedulingIntents: SchedulingIntentV1[];
  commitments: NormalizedCommitmentV1[]; observations: ObservationV1[]; proposals: ProposalV1[];
  evidence: PrivacyEvidenceV1[]; patterns: { id: string; sources: Source[]; createdAt: string }[];
  derivedCurves?: { id: string; sources: Source[]; createdAt: string; summary: string }[]; pinnedEntityIds?: string[];
  effectAuthority: { id: string; source: Source; createdAt: string }[];
  proposalReceipts: ProposalReceiptV1[];
  focusSettings: { enabled: boolean; windows: { start: string; end: string }[] };
  commandReceipts: Record<string, StoredReceipt>;
};
type PrivacyKind = "revoke-source" | "delete-source" | "forget-pattern" | "delete-profile" | "prune";
type BaseCommand<K extends PrivacyKind> = Readonly<{ schemaVersion: 1; kind: K; commandId: string; idempotencyKey: string; expectedRevision: number; at: string }>;
type SourceCommand<K extends "revoke-source" | "delete-source"> = BaseCommand<K> & Readonly<{ source: ConnectorSource }>;
type ForgetCommand = BaseCommand<"forget-pattern"> & Readonly<{ patternRef: string }>;
type ProfileCommand = BaseCommand<"delete-profile"> & Readonly<{ exportOffered: boolean }>;
type PruneCommand = BaseCommand<"prune">;
export type PrivacyRemovedV1 = Readonly<{ tasks: number; intents: number; commitments: number; observations: number; proposals: number; evidence: number; patterns: number; derived: number; effects: number; connectors: number; receipts: number }>;
export type PrivacyReceiptV1 = Readonly<{ schemaVersion: 1; kind: PrivacyKind; commandId: string; idempotencyKey: string; revision: number; removed: PrivacyRemovedV1; remoteRevocation: "confirmed" | "failed" | "not-attempted" }>;
export type PrivacyEventV1 = Readonly<{ schemaVersion: 1; type: "PrivacyChanged"; kind: PrivacyKind; commandId: string; occurredAt: string; revision: number; removed: PrivacyRemovedV1 }>;
type StoredReceipt = { fingerprint: string; receipt: PrivacyReceiptV1; event: PrivacyEventV1 };
export type PrivacyTransitionResult = Readonly<{ state: PrivacyStateV1; event: PrivacyEventV1; receipt: PrivacyReceiptV1 }>;

const emptyRemoved = (): PrivacyRemovedV1 => ({ tasks: 0, intents: 0, commitments: 0, observations: 0, proposals: 0, evidence: 0, patterns: 0, derived: 0, effects: 0, connectors: 0, receipts: 0 });
const validInstant = (value: string) => { try { return value.endsWith("Z") && Temporal.Instant.from(value).toString() === value; } catch { return false; } };
const fingerprint = (command: BaseCommand<PrivacyKind> & Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))));
const deepClone = (state: PrivacyStateV1): PrivacyStateV1 => structuredClone(state);
const previous = (state: PrivacyStateV1, command: BaseCommand<PrivacyKind> & Record<string, unknown>): PrivacyTransitionResult | null => {
  const byKey = state.commandReceipts[command.idempotencyKey];
  const byCommandId = Object.values(state.commandReceipts).find((item) => item.receipt.commandId === command.commandId);
  if (!byKey && !byCommandId) return null;
  const stored = byKey ?? byCommandId!;
  if (!byKey || !byCommandId || byKey !== byCommandId || stored.fingerprint !== fingerprint(command)) throw new RangeError("IDEMPOTENCY_COLLISION");
  return Object.freeze({ state, event: stored.event, receipt: stored.receipt });
};
const validate = (state: PrivacyStateV1, command: BaseCommand<PrivacyKind> & Record<string, unknown>) => {
  if (command.schemaVersion !== 1 || !command.commandId || !command.idempotencyKey || !validInstant(command.at)) throw new RangeError("INVALID_PRIVACY_COMMAND");
  const common = ["at", "commandId", "expectedRevision", "idempotencyKey", "kind", "schemaVersion"], specific: Record<PrivacyKind, string[]> = {
    "revoke-source": ["source"], "delete-source": ["source"], "forget-pattern": ["patternRef"], "delete-profile": ["exportOffered"], prune: [],
  };
  if (Object.keys(command).sort().join() !== [...common, ...specific[command.kind]].sort().join()) throw new RangeError("INVALID_PRIVACY_COMMAND");
  if (command.expectedRevision !== state.revision) throw new RangeError("REVISION_CONFLICT");
};
const finish = (state: PrivacyStateV1, command: BaseCommand<PrivacyKind> & Record<string, unknown>, removed: PrivacyRemovedV1, remoteRevocation: PrivacyReceiptV1["remoteRevocation"]): PrivacyTransitionResult => {
  state.revision += 1;
  const receipt: PrivacyReceiptV1 = Object.freeze({ schemaVersion: 1, kind: command.kind, commandId: command.commandId, idempotencyKey: command.idempotencyKey, revision: state.revision, removed, remoteRevocation });
  const event: PrivacyEventV1 = Object.freeze({ schemaVersion: 1, type: "PrivacyChanged", kind: command.kind, commandId: command.commandId, occurredAt: command.at, revision: state.revision, removed });
  state.commandReceipts[command.idempotencyKey] = { fingerprint: fingerprint(command), receipt, event };
  return Object.freeze({ state, event, receipt });
};
const sourceTransition = (input: PrivacyStateV1, command: SourceCommand<"revoke-source" | "delete-source">): PrivacyTransitionResult => {
  const replay = previous(input, command); if (replay) return replay; validate(input, command);
  const state = deepClone(input), taskIds = new Set(state.tasks.filter((item) => item.source === command.source || item.provenance.source === command.source).map((item) => item.id));
  const before = { tasks: state.tasks.length, intents: state.schedulingIntents.length, commitments: state.commitments.length, observations: state.observations.length, proposals: state.proposals.length, evidence: state.evidence.length, patterns: state.patterns.length, derived: state.derivedCurves?.length ?? 0, effects: state.effectAuthority.length, connectors: state.connectors.length, receipts: state.proposalReceipts.length };
  state.tasks = state.tasks.filter((item) => !taskIds.has(item.id));
  state.schedulingIntents = state.schedulingIntents.filter((item) => !taskIds.has(item.taskId));
  state.commitments = state.commitments.filter((item) => item.provenance.source !== command.source);
  state.observations = state.observations.filter((item) => item.provenance.source !== command.source);
  state.proposals = state.proposals.filter((item) => !taskIds.has(item.taskId));
  state.evidence = state.evidence.filter((item) => item.source !== command.source);
  const removedPatternIds = new Set(state.patterns.filter((item) => item.sources.includes(command.source)).map((item) => item.id));
  state.patterns = state.patterns.filter((item) => !removedPatternIds.has(item.id));
  if (state.derivedCurves) state.derivedCurves = state.derivedCurves.filter((item) => !item.sources.includes(command.source));
  state.evidence = state.evidence.filter((item) => !item.patternRef || !removedPatternIds.has(item.patternRef));
  state.effectAuthority = state.effectAuthority.filter((item) => item.source !== command.source);
  state.connectors = state.connectors.filter((item) => item.source !== command.source);
  state.proposalReceipts = state.proposalReceipts.filter((item) => item.source !== command.source && (item.taskId === null || !taskIds.has(item.taskId)));
  const removed: PrivacyRemovedV1 = {
    tasks: before.tasks - state.tasks.length, intents: before.intents - state.schedulingIntents.length,
    commitments: before.commitments - state.commitments.length, observations: before.observations - state.observations.length,
    proposals: before.proposals - state.proposals.length, evidence: before.evidence - state.evidence.length,
    patterns: before.patterns - state.patterns.length, derived: before.derived - (state.derivedCurves?.length ?? 0), effects: before.effects - state.effectAuthority.length,
    connectors: before.connectors - state.connectors.length, receipts: before.receipts - state.proposalReceipts.length,
  };
  return finish(state, command, removed, "not-attempted");
};

export const revokeSource = (state: PrivacyStateV1, command: SourceCommand<"revoke-source">) => sourceTransition(state, command);
export const deleteSource = (state: PrivacyStateV1, command: SourceCommand<"delete-source">) => sourceTransition(state, command);
export const forgetPattern = (input: PrivacyStateV1, command: ForgetCommand): PrivacyTransitionResult => {
  const replay = previous(input, command); if (replay) return replay; validate(input, command);
  const state = deepClone(input), beforePatterns = state.patterns.length, beforeEvidence = state.evidence.length;
  state.patterns = state.patterns.filter((item) => item.id !== command.patternRef);
  state.evidence = state.evidence.filter((item) => item.patternRef !== command.patternRef);
  return finish(state, command, { ...emptyRemoved(), patterns: beforePatterns - state.patterns.length, evidence: beforeEvidence - state.evidence.length }, "not-attempted");
};
export const deleteProfile = (input: PrivacyStateV1, command: ProfileCommand): PrivacyTransitionResult => {
  const replay = previous(input, command); if (replay) return replay; validate(input, command);
  if (!command.exportOffered) throw new RangeError("EXPORT_REQUIRED");
  const state = deepClone(input), removed: PrivacyRemovedV1 = { tasks: state.tasks.length, intents: state.schedulingIntents.length, commitments: state.commitments.length, observations: state.observations.length, proposals: state.proposals.length, evidence: state.evidence.length, patterns: state.patterns.length, derived: state.derivedCurves?.length ?? 0, effects: state.effectAuthority.length, connectors: state.connectors.length, receipts: state.proposalReceipts.length };
  state.profileId = "deleted"; state.profileDeleted = true; state.connectors = []; state.tasks = []; state.schedulingIntents = []; state.commitments = []; state.observations = []; state.proposals = []; state.evidence = []; state.patterns = []; state.derivedCurves = []; state.pinnedEntityIds = []; state.effectAuthority = []; state.proposalReceipts = []; state.focusSettings = { enabled: false, windows: [] };
  return finish(state, command, removed, "not-attempted");
};
const olderThanDays = (createdAt: string, boundary: string, days: number) => Temporal.Instant.compare(Temporal.Instant.from(createdAt).add({ hours: days * 24 }), Temporal.Instant.from(boundary)) < 0;
export const prunePrivacy = (input: PrivacyStateV1, command: PruneCommand): PrivacyTransitionResult => {
  const replay = previous(input, command); if (replay) return replay; validate(input, command);
  const state = deepClone(input), tasks = state.tasks.length, intents = state.schedulingIntents.length, commitments = state.commitments.length, observations = state.observations.length, proposals = state.proposals.length, evidence = state.evidence.length, patterns = state.patterns.length, derived = state.derivedCurves?.length ?? 0, effects = state.effectAuthority.length, receipts = state.proposalReceipts.length;
  const pinned = new Set(state.pinnedEntityIds ?? []), removedTaskIds = new Set(state.tasks.filter((item) => !pinned.has(item.id) && olderThanDays(item.provenance.importedAt, command.at, 30)).map((item) => item.id));
  state.tasks = state.tasks.filter((item) => !removedTaskIds.has(item.id));
  state.schedulingIntents = state.schedulingIntents.filter((item) => !removedTaskIds.has(item.taskId));
  state.proposals = state.proposals.filter((item) => !removedTaskIds.has(item.taskId));
  state.commitments = state.commitments.filter((item) => pinned.has(item.id) || !olderThanDays(item.provenance.importedAt, command.at, 30));
  state.observations = state.observations.filter((item) => pinned.has(item.id) || !olderThanDays(item.provenance.importedAt, command.at, 30));
  state.evidence = state.evidence.filter((item) => item.pinned || !olderThanDays(item.createdAt, command.at, 30));
  state.patterns = state.patterns.filter((item) => !olderThanDays(item.createdAt, command.at, 90));
  if (state.derivedCurves) state.derivedCurves = state.derivedCurves.filter((item) => !olderThanDays(item.createdAt, command.at, 90));
  const patternIds = new Set(state.patterns.map((item) => item.id)); state.evidence = state.evidence.filter((item) => !item.patternRef || patternIds.has(item.patternRef));
  state.effectAuthority = state.effectAuthority.filter((item) => !olderThanDays(item.createdAt, command.at, 30));
  state.proposalReceipts = state.proposalReceipts.filter((item) => !olderThanDays(item.createdAt, command.at, 30));
  return finish(state, command, { ...emptyRemoved(), tasks: tasks - state.tasks.length, intents: intents - state.schedulingIntents.length, commitments: commitments - state.commitments.length, observations: observations - state.observations.length, proposals: proposals - state.proposals.length, evidence: evidence - state.evidence.length, patterns: patterns - state.patterns.length, derived: derived - (state.derivedCurves?.length ?? 0), effects: effects - state.effectAuthority.length, receipts: receipts - state.proposalReceipts.length }, "not-attempted");
};

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const exportPrivacy = (state: PrivacyStateV1) => ({
  schemaVersion: 1 as const, exportedRevision: state.revision, timeZone: state.timeZone,
  focusSettings: structuredClone(state.focusSettings),
  connectors: state.connectors.map((item) => ({ source: item.source, mode: item.mode, capabilities: [...item.capabilities], consentRevision: item.consentRevision, freshness: item.freshness.state, fetchedAt: item.freshness.fetchedAt })).sort((a, b) => compare(a.source, b.source)),
  tasks: state.tasks.map((item) => ({ source: item.source, title: item.title, state: item.state, durationMinutes: item.durationMinutes, deadlineAt: item.deadlineAt, priority: item.priority, labels: [...item.labels], immutable: item.immutable, freshness: item.provenance.freshness.state })).sort((a, b) => compare(`${a.source}:${a.title}`, `${b.source}:${b.title}`)),
  schedulingIntents: state.schedulingIntents.map(({ requiredCapacity, goalAlignment }) => ({ requiredCapacity, goalAlignment })).sort((a, b) => (a.requiredCapacity ?? -1) - (b.requiredCapacity ?? -1)),
  commitments: state.commitments.map((item) => ({ kind: item.kind, title: item.title, startAt: item.startAt, endAt: item.endAt, deadlineAt: item.deadlineAt, hard: item.hard, protected: item.protected, source: item.provenance.source, freshness: item.provenance.freshness.state })),
  observations: state.observations.map((item) => ({ observedAt: item.observedAt, localTime: item.localTime, value: item.value, reliability: item.reliability, signal: item.signal, source: item.provenance.source, freshness: item.provenance.freshness.state })),
  proposals: state.proposals.map((item) => ({ startAt: item.startAt, endAt: item.endAt, score: item.score, breakdown: { ...item.breakdown }, confidence: item.confidence, limitations: [...item.limitations], status: item.status })),
  evidenceSummaries: state.evidence.map((item) => ({ source: item.source, summary: item.summary, createdAt: item.createdAt, pinned: item.pinned })).sort((a, b) => compare(`${a.source}:${a.createdAt}:${a.summary}`, `${b.source}:${b.createdAt}:${b.summary}`)),
  derivedDailyCurves: (state.derivedCurves ?? []).map(({ sources, createdAt, summary }) => ({ sources: [...sources].sort(compare), createdAt, summary })).sort((a, b) => compare(`${a.createdAt}:${a.summary}`, `${b.createdAt}:${b.summary}`)),
  proposalReceipts: state.proposalReceipts.map(({ source, createdAt, summary }) => ({ source, createdAt, summary })).sort((a, b) => compare(`${a.source}:${a.createdAt}`, `${b.source}:${b.createdAt}`)),
});
