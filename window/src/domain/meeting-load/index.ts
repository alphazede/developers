import { Temporal } from "@js-temporal/polyfill";

import type { MeetingPatternKey } from "../../server/security/crypto";

export type MeetingOccurrenceInput = Readonly<{
  occurrenceId: string;
  occurredAt: string;
  seriesRef: string;
  providerParticipantIds: readonly string[];
  change: number;
  reliability: number;
  source: string;
  consentRevision: number;
  status: "active" | "revoked";
}>;

type Classification = "historically-demanding" | "neutral" | "unknown";
type Feedback = Readonly<{ patternKey: string; disposition: "confirm" | "reject" }>;
export type MeetingPattern = Readonly<{
  patternKey: string; classification: Classification; wording: "Historically demanding meeting pattern" | "Neutral meeting pattern" | "Not enough evidence";
  occurrenceCount: number; distinctUtcDates: number; newestAgeDays: number; confidence: number; weightedChange: number | null;
  confidenceComponents: Readonly<{ count: number; distinctDates: number; freshness: number }>;
  limitations: readonly string[];
}>;
export type RecoveryInput = Readonly<{ patternKey: string; suggestedBufferMinutes: 15; confidence: number; rationale: "Observational meeting-pattern history supports a recovery buffer." }>;
export type MeetingLoadState = Readonly<{
  revision: number; patterns: readonly MeetingPattern[]; feedback: readonly Feedback[]; recoveryInputs: readonly RecoveryInput[];
  proposals: readonly { patternKey: string }[]; explanations: readonly { patternKey: string }[];
  sources: Readonly<Record<string, readonly string[]>>;
}>;
export type MeetingLoadAnalysis = Readonly<{ patterns: readonly MeetingPattern[]; recoveryInputs: readonly RecoveryInput[]; state: MeetingLoadState }>;
export type MeetingLoadCommand =
  | Readonly<{ kind: "confirm" | "reject"; patternKey: string }>
  | Readonly<{ kind: "forget-pattern"; patternKey: string }>
  | Readonly<{ kind: "forget-source"; source: string }>
  | Readonly<{ kind: "key-rotation" | "key-loss" }>;

type Grouped = { count: number; dates: Set<string>; newestAt: Temporal.Instant; weighted: number; weights: number; positive: boolean; negative: boolean; sources: Set<string> };
const fail = (): never => { throw new Error("INVALID_MEETING_LOAD_INPUT"); };
const round = (value: number) => Number(value.toFixed(4));
const canonicalUtc = (value: unknown) => {
  if (typeof value !== "string") return fail();
  if (!value.endsWith("Z")) return fail();
  try {
    const instant = Temporal.Instant.from(value);
    if (instant.toString() !== value) fail();
    return instant;
  } catch { return fail(); }
};
const ageDays = (newer: Temporal.Instant, older: Temporal.Instant) => Number(newer.epochNanoseconds - older.epochNanoseconds) / 86_400_000_000_000;
const validKey = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const wording = (classification: Classification): MeetingPattern["wording"] => classification === "historically-demanding"
  ? "Historically demanding meeting pattern" : classification === "neutral" ? "Neutral meeting pattern" : "Not enough evidence";
const derived = (patterns: readonly MeetingPattern[]): readonly RecoveryInput[] => patterns.flatMap((pattern) => pattern.classification === "historically-demanding" ? [{
  patternKey: pattern.patternKey, suggestedBufferMinutes: 15 as const, confidence: pattern.confidence,
  rationale: "Observational meeting-pattern history supports a recovery buffer." as const,
}] : []);

export const analyzeMeetingLoad = (occurrences: readonly MeetingOccurrenceInput[], now: string, key: MeetingPatternKey): MeetingLoadAnalysis => {
  const current = canonicalUtc(now);
  if (occurrences.length > 2000) fail();
  const groups = new Map<string, Grouped>();
  const occurrenceIds = new Set<string>();
  for (const occurrence of occurrences) {
    if (!occurrence || typeof occurrence.occurrenceId !== "string" || !occurrence.occurrenceId || occurrenceIds.has(occurrence.occurrenceId)) fail();
    occurrenceIds.add(occurrence.occurrenceId);
  }
  for (const occurrence of occurrences) {
    if (!occurrence || typeof occurrence.occurrenceId !== "string" || !occurrence.occurrenceId || typeof occurrence.seriesRef !== "string" || !occurrence.seriesRef
      || !Array.isArray(occurrence.providerParticipantIds) || !occurrence.providerParticipantIds.length || occurrence.providerParticipantIds.some((id) => typeof id !== "string" || !id)
      || !Number.isFinite(occurrence.change) || occurrence.change < -1 || occurrence.change > 1 || !Number.isFinite(occurrence.reliability) || occurrence.reliability < 0 || occurrence.reliability > 1
      || typeof occurrence.source !== "string" || !occurrence.source || !Number.isSafeInteger(occurrence.consentRevision) || occurrence.consentRevision < 0 || !["active", "revoked"].includes(occurrence.status)) fail();
    const instant = canonicalUtc(occurrence.occurredAt); if (instant.epochNanoseconds > current.epochNanoseconds) fail();
    if (occurrence.status === "revoked" || occurrence.reliability === 0) continue;
    const patternKey = key.digest(occurrence.seriesRef, occurrence.providerParticipantIds);
    const days = ageDays(current, instant); const weight = occurrence.reliability * 2 ** (-days / 14);
    const group = groups.get(patternKey) ?? { count: 0, dates: new Set<string>(), newestAt: instant, weighted: 0, weights: 0, positive: false, negative: false, sources: new Set<string>() };
    group.count += 1; group.dates.add(occurrence.occurredAt.slice(0, 10)); group.newestAt = group.newestAt.epochNanoseconds > instant.epochNanoseconds ? group.newestAt : instant; group.weighted += occurrence.change * weight; group.weights += weight;
    group.positive ||= occurrence.change > 0; group.negative ||= occurrence.change < 0; group.sources.add(occurrence.source); groups.set(patternKey, group);
  }
  const sourceMap: Record<string, readonly string[]> = {};
  const patterns = [...groups].map(([patternKey, group]) => {
    const newestAgeDays = ageDays(current, group.newestAt); const count = Math.min(1, group.count / 5); const distinctDates = Math.min(1, group.dates.size / 5); const freshness = Math.max(0, 1 - newestAgeDays / 14);
    const confidence = (count + distinctDates + freshness) / 3; const weightedChange = group.weights ? group.weighted / group.weights : null;
    const qualifies = group.count >= 3 && group.dates.size >= 3 && newestAgeDays <= 14 && confidence >= 0.55 - Number.EPSILON;
    const conflicting = group.positive && group.negative;
    const classification: Classification = !qualifies || conflicting ? "unknown" : weightedChange !== null && weightedChange <= -0.25 ? "historically-demanding" : "neutral";
    sourceMap[patternKey] = [...group.sources].sort();
    return { patternKey, classification, wording: wording(classification), occurrenceCount: group.count, distinctUtcDates: group.dates.size, newestAgeDays: round(newestAgeDays), confidence: round(confidence), weightedChange: weightedChange === null ? null : round(weightedChange),
      confidenceComponents: { count: round(count), distinctDates: round(distinctDates), freshness: round(freshness) }, limitations: classification === "unknown" ? [conflicting ? "Conflicting observational evidence." : "Not enough qualifying observational evidence."] : ["Observational evidence only."],
    };
  }).sort((a, b) => a.patternKey.localeCompare(b.patternKey));
  const recoveryInputs = derived(patterns); const state: MeetingLoadState = { revision: 0, patterns, feedback: [], recoveryInputs, proposals: [], explanations: [], sources: sourceMap };
  return { patterns, recoveryInputs, state };
};

export const transitionMeetingLoad = (state: MeetingLoadState, command: MeetingLoadCommand): MeetingLoadState => {
  validateState(state);
  if (!command || typeof command !== "object" || !("kind" in command)) fail();
  const remove = (keys: ReadonlySet<string>): MeetingLoadState => {
    const patterns = state.patterns.filter((item) => !keys.has(item.patternKey));
    const sources = Object.fromEntries(Object.entries(state.sources).filter(([patternKey]) => !keys.has(patternKey)));
    const next = { revision: state.revision + 1, patterns, feedback: state.feedback.filter((item) => !keys.has(item.patternKey)), recoveryInputs: state.recoveryInputs.filter((item) => !keys.has(item.patternKey)), proposals: state.proposals.filter((item) => !keys.has(item.patternKey)), explanations: state.explanations.filter((item) => !keys.has(item.patternKey)), sources };
    validateState(next);
    return next;
  };
  if (command.kind === "key-rotation" || command.kind === "key-loss") return remove(new Set(state.patterns.map((item) => item.patternKey)));
  if (command.kind === "forget-pattern") {
    if (!validKey(command.patternKey) || !state.patterns.some((item) => item.patternKey === command.patternKey)) fail();
    return remove(new Set([command.patternKey]));
  }
  if (command.kind === "forget-source") return remove(new Set(Object.entries(state.sources).filter(([, sources]) => sources.includes(command.source)).map(([patternKey]) => patternKey)));
  if (command.kind === "confirm" || command.kind === "reject") {
    if (!validKey(command.patternKey) || !state.patterns.some((item) => item.patternKey === command.patternKey)) fail();
    const next = { ...state, revision: state.revision + 1, feedback: [...state.feedback.filter((item) => item.patternKey !== command.patternKey), { patternKey: command.patternKey, disposition: command.kind }] };
    validateState(next);
    return next;
  }
  return fail();
};

const validateState = (state: MeetingLoadState) => {
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.patterns) || !Array.isArray(state.feedback)
    || !Array.isArray(state.recoveryInputs) || !Array.isArray(state.proposals) || !Array.isArray(state.explanations) || !state.sources || typeof state.sources !== "object" || Array.isArray(state.sources)) fail();
  const keys = new Set<string>();
  for (const pattern of state.patterns) {
    if (!pattern || !validKey(pattern.patternKey) || keys.has(pattern.patternKey)) fail();
    keys.add(pattern.patternKey);
  }
  const sourceKeys = Object.keys(state.sources);
  if (sourceKeys.length !== keys.size || sourceKeys.some((patternKey) => !keys.has(patternKey)
    || !Array.isArray(state.sources[patternKey]) || !state.sources[patternKey].length || state.sources[patternKey].some((source) => typeof source !== "string" || !source))) fail();
  const feedbackKeys = new Set<string>();
  for (const feedback of state.feedback) {
    if (!feedback || !keys.has(feedback.patternKey) || !["confirm", "reject"].includes(feedback.disposition) || feedbackKeys.has(feedback.patternKey)) fail();
    feedbackKeys.add(feedback.patternKey);
  }
  for (const dependent of [...state.recoveryInputs, ...state.proposals, ...state.explanations]) {
    if (!dependent || !keys.has(dependent.patternKey)) fail();
  }
};
