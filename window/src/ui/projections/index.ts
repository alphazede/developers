import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import {
  accessibleVisualizationV1Schema,
  localStateV1Schema,
  type AccessibleVisualizationV1,
  type LocalStateV1,
  type Source,
} from "../../contracts/v1";
import type { Candidate, TargetEvaluation, TargetRejectionCode } from "../../domain/schedule";

const MAX_CAPACITY_POINTS = 100;
const MAX_RECOVERY = 2_000;
const MAX_CANDIDATES = 3;
const MAX_TARGETS = 2_976;
const UUID = z.string().uuid();
const canonicalInstant = z.string().max(40).superRefine((value, context) => {
  try {
    if (!value.endsWith("Z") || Temporal.Instant.from(value).toString() !== value) context.addIssue({ code: "custom" });
  } catch {
    context.addIssue({ code: "custom" });
  }
});
const boundedText = z.string().min(1).max(512);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const breakdownSchema = z.object({
  capacityFit: z.number().int().min(0).max(40),
  deadlineUrgency: z.number().int().min(0).max(25),
  goalAlignment: z.number().int().min(0).max(15),
  contextSwitch: z.number().int().min(0).max(10),
  recoverySupport: z.number().int().min(0).max(10),
}).strict();
const evidenceComponentsSchema = z.object({
  effectiveSampleSize: z.number().finite().nonnegative(), sampleScore: z.number().min(0).max(1),
  dateScore: z.number().min(0).max(1), freshnessScore: z.number().min(0).max(1),
}).strict();
const candidateSchema = z.object({
  id: UUID, requestHash: z.string().regex(/^[a-f0-9]{64}$/), taskId: UUID,
  startAt: canonicalInstant, endAt: canonicalInstant, score: z.number().int().min(0).max(100),
  breakdown: breakdownSchema, confidence: z.number().min(0).max(1).nullable(),
  limitations: z.array(boundedText).max(100),
}).strict();
const targetResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestHash: z.string().regex(/^[a-f0-9]{64}$/), candidate: candidateSchema }).strict(),
  z.object({ ok: z.literal(false), rejection: z.enum(["outside-horizon", "duration", "hard-conflict", "after-deadline", "permission"]) }).strict(),
]);
const meetingExplanation = "Observational evidence only. This is a private personal pattern—not medical or causal, not a stress or toxic label, and not a judgment about any person or contact." as const;
const meetingRecoveryRationale = "Observational meeting-pattern history supports a recovery buffer." as const;
const meetingWarningSchema = z.object({
  schemaVersion: z.literal(1),
  classification: z.enum(["historically-demanding", "neutral", "unknown"]),
  wording: z.enum(["Historically demanding meeting pattern", "Neutral meeting pattern", "Not enough evidence"]),
  occurrenceCount: z.number().int().min(1).max(2_000),
  distinctUtcDates: z.number().int().min(1).max(2_000),
  newestAgeDays: z.number().finite().nonnegative().max(36_500),
  weightedChange: z.number().finite().min(-1).max(1).nullable(),
  confidence: z.number().min(0).max(1),
  confidenceComponents: z.object({
    count: z.number().min(0).max(1),
    distinctDates: z.number().min(0).max(1),
    freshness: z.number().min(0).max(1),
  }).strict(),
  limitations: z.array(z.enum([
    "Observational evidence only.",
    "Conflicting observational evidence.",
    "Not enough qualifying observational evidence.",
  ])).min(1).max(2),
  explanation: z.literal(meetingExplanation),
  recovery: z.object({ minutes: z.literal(15), rationale: z.literal(meetingRecoveryRationale) }).strict().nullable(),
}).strict().superRefine((warning, context) => {
  const expectedWording = warning.classification === "historically-demanding"
    ? "Historically demanding meeting pattern"
    : warning.classification === "neutral" ? "Neutral meeting pattern" : "Not enough evidence";
  if (warning.wording !== expectedWording
    || warning.distinctUtcDates > warning.occurrenceCount
    || (warning.classification === "historically-demanding") !== (warning.recovery !== null)) {
    context.addIssue({ code: "custom" });
  }
});
const todayInputSchema = z.object({
  schemaVersion: z.literal(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1).max(64),
  state: localStateV1Schema,
  capacityPoints: z.array(z.object({
    id: UUID, startAt: canonicalInstant, capacity: z.number().int().min(0).max(100).nullable(),
    confidence: z.number().min(0).max(1), components: evidenceComponentsSchema,
    limitations: z.array(boundedText).max(100),
  }).strict()).max(MAX_CAPACITY_POINTS),
  focusGate: z.object({
    enabled: z.boolean(),
    evaluation: z.object({
      ok: z.literal(true), allowed: z.boolean(),
      code: z.enum(["focus-gate-closed", "imported-task-immutable", "task-deletion-not-supported"]).optional(),
      adjustedBoundaries: z.array(z.object({ requestedWallTime: boundedText, resolvedWallTime: boundedText }).strict()).max(4).optional(),
    }).strict(),
    nextBoundaryAt: canonicalInstant.nullable(),
  }).strict(),
  recovery: z.array(z.object({
    id: UUID, title: boundedText, startAt: canonicalInstant, endAt: canonicalInstant, approved: z.boolean(),
  }).strict()).max(MAX_RECOVERY),
  meetingWarning: meetingWarningSchema.nullable(),
  candidates: z.array(candidateSchema).max(MAX_CANDIDATES),
  targetEvaluations: z.array(z.object({ taskId: UUID, startAt: canonicalInstant, result: targetResultSchema }).strict()).max(MAX_TARGETS),
}).strict();
const commandSchema = z.object({
  schemaVersion: z.literal(1), commandId: UUID, taskId: UUID, sourceRevision: revision,
  proposalRevision: revision, targetAt: canonicalInstant,
}).strict();

export type DisplayCapacityPointInput = Readonly<{
  id: string; startAt: string; capacity: number | null; confidence: number;
  components: Readonly<{ effectiveSampleSize: number; sampleScore: number; dateScore: number; freshnessScore: number }>;
  limitations: readonly string[];
}>;
export type RecoveryProjectionInput = Readonly<{
  id: string; title: string; startAt: string; endAt: string; approved: boolean;
}>;
export type MeetingWarningV1 = Readonly<{
  schemaVersion: 1;
  classification: "historically-demanding" | "neutral" | "unknown";
  wording: "Historically demanding meeting pattern" | "Neutral meeting pattern" | "Not enough evidence";
  occurrenceCount: number;
  distinctUtcDates: number;
  newestAgeDays: number;
  weightedChange: number | null;
  confidence: number;
  confidenceComponents: Readonly<{ count: number; distinctDates: number; freshness: number }>;
  limitations: readonly ("Observational evidence only." | "Conflicting observational evidence." | "Not enough qualifying observational evidence.")[];
  explanation: typeof meetingExplanation;
  recovery: Readonly<{ minutes: 15; rationale: typeof meetingRecoveryRationale }> | null;
}>;
export type TodayProjectionInput = Readonly<{
  schemaVersion: 1; date: string; timeZone: string; state: LocalStateV1;
  capacityPoints: readonly DisplayCapacityPointInput[];
  focusGate: Readonly<{
    enabled: boolean;
    evaluation: Readonly<{ ok: true; allowed: boolean; code?: "focus-gate-closed" | "imported-task-immutable" | "task-deletion-not-supported"; adjustedBoundaries?: readonly Readonly<{ requestedWallTime: string; resolvedWallTime: string }>[] }>;
    nextBoundaryAt: string | null;
  }>;
  recovery: readonly RecoveryProjectionInput[];
  meetingWarning: MeetingWarningV1 | null;
  candidates: readonly Candidate[];
  targetEvaluations: readonly Readonly<{ taskId: string; startAt: string; result: TargetEvaluation }>[];
}>;
export type TargetPlacementCommand = Readonly<{
  schemaVersion: 1; commandId: string; taskId: string; sourceRevision: number; proposalRevision: number; targetAt: string;
}>;
export type CapacityPointV1 = Readonly<{
  schemaVersion: 1; id: string; startAt: string; timeLabel: string; capacity: number | null;
  confidence: number; components: Readonly<{ effectiveSampleSize: number; sampleScore: number; dateScore: number; freshnessScore: number }>;
  status: "known" | "unknown"; statusLabel: string; limitations: readonly string[];
}>;
export type BacklogTaskV1 = Readonly<{
  schemaVersion: 1; id: string; title: string; source: "local" | "fixture" | "github" | "linear";
  sourceLabel: string; state: string; durationMinutes: number | null; deadlineAt: string | null;
  mutable: boolean; mutabilityLabel: string;
  intent: Readonly<{ requiredCapacity: number | null; goalAlignment: number | null }> | null;
}>;
export type TimelineEntryV1 = Readonly<{
  schemaVersion: 1; id: string; type: "hard" | "protected" | "recovery" | "task" | "proposal";
  startAt: string; endAt: string; startLabel: string; endLabel: string; title: string;
  source: Source; sourceLabel: string; status: string; statusLabel: string; taskId: string | null;
  mutabilityLabel: string; score: number | null; breakdown: Candidate["breakdown"] | null;
  confidence: number | null; limitations: readonly string[];
}>;
export type PlacementTargetV1 = Readonly<{
  schemaVersion: 1; key: string; taskId: string; startAt: string; timeLabel: string; status: "candidate";
  label: string; candidate: Candidate;
}> | Readonly<{
  schemaVersion: 1; key: string; taskId: string; startAt: string; timeLabel: string; status: "rejected";
  label: string; rejection: TargetRejectionCode;
}>;
export type TodayProjectionV1 = Readonly<{
  schemaVersion: 1; revision: number; date: string; timeZone: string; dayStartAt: string; dayEndAt: string;
  capacityPoints: readonly CapacityPointV1[]; timeline: readonly TimelineEntryV1[]; backlog: readonly BacklogTaskV1[];
  focusGate: Readonly<{ enabled: boolean; state: "disabled" | "open" | "read-only"; allowed: boolean; label: string; nextBoundaryAt: string | null; nextBoundaryLabel: string | null }>;
  meetingWarning: MeetingWarningV1 | null;
  placementTargets: Readonly<Record<string, PlacementTargetV1>>;
  visualization: AccessibleVisualizationV1;
}>;

const sourceLabels: Record<Source, string> = {
  local: "Local", fixture: "Fixture", "google-calendar": "Google Calendar", gmail: "Gmail",
  github: "GitHub", linear: "Linear", microsoft: "Microsoft", strava: "Strava", oura: "Oura", ics: "ICS",
};
const priorities: Record<TimelineEntryV1["type"], number> = { hard: 0, protected: 1, recovery: 2, task: 3, proposal: 4 };
const rejectionLabels: Record<TargetRejectionCode, string> = {
  "outside-horizon": "Outside the scheduling horizon",
  duration: "Task does not fit before the day ends",
  "hard-conflict": "Conflicts with committed or protected time",
  "after-deadline": "Task would end after its deadline",
  permission: "Placement is read-only",
};
const compareBytes = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const compareInstants = (left: string, right: string) => Temporal.Instant.compare(left, right);
const within = (value: string, start: string, end: string) => compareInstants(value, start) >= 0 && compareInstants(value, end) < 0;
const overlapsDay = (startAt: string, endAt: string, dayStartAt: string, dayEndAt: string) => compareInstants(startAt, dayEndAt) < 0 && compareInstants(endAt, dayStartAt) > 0;
const canonicalizeInstant = (value: string) => Temporal.Instant.from(value).toString();
const timeLabel = (value: string, timeZone: string, includeDate = false) => {
  const zoned = Temporal.Instant.from(value).toZonedDateTimeISO(timeZone);
  const clock = `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")} ${zoned.offset}`;
  return includeDate ? `${zoned.toPlainDate()} ${clock}` : clock;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const invalid = (): never => { throw new RangeError("INVALID_TODAY_PROJECTION"); };
const cloneBreakdown = (value: Candidate["breakdown"]): Candidate["breakdown"] => ({ ...value });
const cloneCandidate = (value: Candidate): Candidate => ({ ...value, breakdown: cloneBreakdown(value.breakdown), limitations: [...value.limitations] });
const mutability = (source: string, immutable: boolean) => immutable || source === "github" || source === "linear"
  ? { mutable: false, label: `Imported ${sourceLabels[source as Source]} task — read-only` }
  : { mutable: true, label: "Local task — editable" };
const validEvidence = (value: Pick<Candidate, "score" | "breakdown" | "confidence" | "limitations">) => {
  const { capacityFit, deadlineUrgency, goalAlignment, contextSwitch, recoverySupport } = value.breakdown;
  return Number.isInteger(capacityFit) && capacityFit >= 0 && capacityFit <= 40
    && Number.isInteger(deadlineUrgency) && deadlineUrgency >= 0 && deadlineUrgency <= 25
    && Number.isInteger(goalAlignment) && goalAlignment >= 0 && goalAlignment <= 15
    && Number.isInteger(contextSwitch) && contextSwitch >= 0 && contextSwitch <= 10
    && Number.isInteger(recoverySupport) && recoverySupport >= 0 && recoverySupport <= 10
    && capacityFit + deadlineUrgency + goalAlignment + contextSwitch + recoverySupport === value.score
    && (value.confidence === null) === value.limitations.includes("capacity_unknown");
};
const validScore = (candidate: Candidate) => validEvidence(candidate) && compareInstants(candidate.startAt, candidate.endAt) < 0;

export const createTargetPlacementCommand = (input: TargetPlacementCommand): TargetPlacementCommand => {
  const result = commandSchema.safeParse(input);
  if (!result.success) throw new RangeError("INVALID_TARGET_PLACEMENT_COMMAND");
  return freeze({ ...result.data });
};

export const buildTodayProjection = (input: TodayProjectionInput): TodayProjectionV1 => {
  const parsed = todayInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const value = parsed.data;
  if (value.state.timeZone !== value.timeZone || /^[+-]/.test(value.timeZone)) return invalid();

  let date: Temporal.PlainDate;
  let dayStartAt: string;
  let dayEndAt: string;
  try {
    date = Temporal.PlainDate.from(value.date);
    if (date.toString() !== value.date) return invalid();
    dayStartAt = date.toZonedDateTime({ timeZone: value.timeZone, plainTime: "00:00" }).toInstant().toString();
    dayEndAt = date.add({ days: 1 }).toZonedDateTime({ timeZone: value.timeZone, plainTime: "00:00" }).toInstant().toString();
  } catch {
    return invalid();
  }

  if (!Number.isSafeInteger(value.state.revision)
    || !value.focusGate.enabled && (!value.focusGate.evaluation.allowed || value.focusGate.evaluation.code !== undefined)
    || value.focusGate.enabled && value.focusGate.evaluation.allowed && value.focusGate.evaluation.code !== undefined
    || value.focusGate.enabled && !value.focusGate.evaluation.allowed && value.focusGate.evaluation.code !== "focus-gate-closed") return invalid();

  const entityIds = new Set<string>();
  const addId = (id: string) => { if (entityIds.has(id)) invalid(); entityIds.add(id); };
  value.state.tasks.forEach((task) => addId(task.id));
  value.state.commitments.forEach((item) => addId(item.id));
  value.state.proposals.forEach((item) => addId(item.id));
  value.capacityPoints.forEach((item) => addId(item.id));
  value.recovery.forEach((item) => addId(item.id));
  const tasks = new Map(value.state.tasks.map((task) => [task.id, task]));
  const intents = new Map(value.state.schedulingIntents.map((intent) => [intent.taskId, intent]));
  const taskDeadlines = new Map(value.state.tasks.map((task) => [task.id, task.deadlineAt === null ? null : canonicalizeInstant(task.deadlineAt)]));
  if (tasks.size !== value.state.tasks.length || intents.size !== value.state.schedulingIntents.length) return invalid();
  if (value.state.schedulingIntents.some((intent) => !tasks.has(intent.taskId))) return invalid();

  const commitments = value.state.commitments.map((commitment) => ({
    ...commitment,
    startAt: commitment.startAt === null ? null : canonicalizeInstant(commitment.startAt),
    endAt: commitment.endAt === null ? null : canonicalizeInstant(commitment.endAt),
    deadlineAt: commitment.deadlineAt === null ? null : canonicalizeInstant(commitment.deadlineAt),
  }));
  for (const commitment of commitments) {
    if ((commitment.startAt === null) !== (commitment.endAt === null)) return invalid();
    if (commitment.startAt && commitment.endAt && compareInstants(commitment.startAt, commitment.endAt) >= 0) return invalid();
  }
  const proposals = value.state.proposals.map((proposal) => ({ ...proposal, startAt: canonicalizeInstant(proposal.startAt), endAt: canonicalizeInstant(proposal.endAt) }));
  for (const proposal of proposals) {
    if (!tasks.has(proposal.taskId) || compareInstants(proposal.startAt, proposal.endAt) >= 0
      || !Number.isSafeInteger(proposal.sourceRevision) || proposal.sourceRevision > value.state.revision || !validEvidence(proposal)) return invalid();
  }
  const candidateBytes = new Map<string, string>();
  let schedulerRequestHash: string | undefined;
  const registerCandidate = (candidate: Candidate, allowEquivalentReuse: boolean) => {
    if (entityIds.has(candidate.id)) return invalid();
    const bytes = JSON.stringify(candidate), prior = candidateBytes.get(candidate.id);
    if (prior !== undefined && (!allowEquivalentReuse || prior !== bytes)) return invalid();
    if (schedulerRequestHash !== undefined && schedulerRequestHash !== candidate.requestHash) return invalid();
    schedulerRequestHash = candidate.requestHash;
    candidateBytes.set(candidate.id, bytes);
  };
  for (const candidate of value.candidates) {
    if (!tasks.has(candidate.taskId) || !validScore(candidate) || !within(candidate.startAt, dayStartAt, dayEndAt) || compareInstants(candidate.endAt, dayEndAt) > 0) return invalid();
    registerCandidate(candidate, false);
  }

  const capacityStarts = new Set<string>();
  const capacityPoints: CapacityPointV1[] = value.capacityPoints.map((point) => {
    if (capacityStarts.has(point.startAt) || !within(point.startAt, dayStartAt, dayEndAt)) return invalid();
    capacityStarts.add(point.startAt);
    const known = point.capacity !== null;
    if (known && point.limitations.includes("capacity_unknown")) return invalid();
    return {
      schemaVersion: 1 as const, id: point.id, startAt: point.startAt, timeLabel: timeLabel(point.startAt, value.timeZone),
      capacity: point.capacity, confidence: point.confidence, components: { ...point.components }, status: known ? "known" as const : "unknown" as const,
      statusLabel: known ? `Known capacity ${point.capacity} of 100` : "Capacity unknown",
      limitations: known ? [...point.limitations] : [...new Set([...point.limitations, "capacity_unknown"])],
    };
  }).sort((a, b) => compareInstants(a.startAt, b.startAt) || compareBytes(a.id, b.id));

  const timeline: TimelineEntryV1[] = [];
  for (const commitment of commitments) {
    if (!commitment.startAt || !commitment.endAt || !overlapsDay(commitment.startAt, commitment.endAt, dayStartAt, dayEndAt)) continue;
    const type: TimelineEntryV1["type"] = commitment.kind === "recovery-buffer" ? "recovery" : commitment.protected ? "protected" : "hard";
    timeline.push({
      schemaVersion: 1, id: commitment.id, type, startAt: commitment.startAt, endAt: commitment.endAt,
      startLabel: timeLabel(commitment.startAt, value.timeZone, compareInstants(commitment.startAt, dayStartAt) < 0 || compareInstants(commitment.endAt, dayEndAt) > 0),
      endLabel: timeLabel(commitment.endAt, value.timeZone, compareInstants(commitment.startAt, dayStartAt) < 0 || compareInstants(commitment.endAt, dayEndAt) > 0),
      title: commitment.title, source: commitment.provenance.source, sourceLabel: sourceLabels[commitment.provenance.source],
      status: type === "recovery" ? commitment.hard ? "approved" : "soft" : type,
      statusLabel: type === "recovery" ? commitment.hard ? "Approved recovery" : "Soft recovery" : type === "protected" ? "Protected time" : "Hard commitment",
      taskId: null, mutabilityLabel: "Commitment — read-only", score: null, breakdown: null, confidence: null, limitations: [],
    });
  }
  for (const recovery of value.recovery) {
    if (compareInstants(recovery.startAt, recovery.endAt) >= 0 || !within(recovery.startAt, dayStartAt, dayEndAt) || compareInstants(recovery.endAt, dayEndAt) > 0) return invalid();
    timeline.push({
      schemaVersion: 1, id: recovery.id, type: "recovery", startAt: recovery.startAt, endAt: recovery.endAt,
      startLabel: timeLabel(recovery.startAt, value.timeZone), endLabel: timeLabel(recovery.endAt, value.timeZone), title: recovery.title,
      source: "local", sourceLabel: sourceLabels.local, status: recovery.approved ? "approved" : "soft",
      statusLabel: recovery.approved ? "Approved recovery" : "Soft recovery", taskId: null,
      mutabilityLabel: recovery.approved ? "Approved recovery — protected" : "Suggested recovery — not protected",
      score: null, breakdown: null, confidence: null, limitations: [],
    });
  }
  const proposalEntry = (proposal: Candidate | LocalStateV1["proposals"][number], type: "task" | "proposal", status: string) => {
    const task = tasks.get(proposal.taskId)!;
    const access = mutability(task.source, task.immutable), crossesBoundary = compareInstants(proposal.startAt, dayStartAt) < 0 || compareInstants(proposal.endAt, dayEndAt) > 0;
    timeline.push({
      schemaVersion: 1, id: proposal.id, type, startAt: proposal.startAt, endAt: proposal.endAt,
      startLabel: timeLabel(proposal.startAt, value.timeZone, crossesBoundary), endLabel: timeLabel(proposal.endAt, value.timeZone, crossesBoundary),
      title: task.title, source: task.source, sourceLabel: sourceLabels[task.source], status,
      statusLabel: type === "proposal" ? "Preview — source task unchanged" : `${status[0]!.toUpperCase()}${status.slice(1)} task placement`,
      taskId: task.id, mutabilityLabel: access.label, score: proposal.score, breakdown: { ...proposal.breakdown },
      confidence: proposal.confidence, limitations: [...proposal.limitations],
    });
  };
  for (const proposal of proposals) {
    if (proposal.status === "rejected" || !overlapsDay(proposal.startAt, proposal.endAt, dayStartAt, dayEndAt)) continue;
    proposalEntry(proposal, proposal.status === "preview" ? "proposal" : "task", proposal.status);
  }
  for (const candidate of value.candidates) proposalEntry(candidate, "proposal", "preview");
  timeline.sort((a, b) => compareInstants(a.startAt, b.startAt) || priorities[a.type] - priorities[b.type] || compareBytes(a.id, b.id));

  const backlog: BacklogTaskV1[] = value.state.tasks.filter((task) => task.state === "open").map((task) => {
    const access = mutability(task.source, task.immutable), intent = intents.get(task.id);
    return {
      schemaVersion: 1 as const, id: task.id, title: task.title, source: task.source, sourceLabel: sourceLabels[task.source],
      state: task.state, durationMinutes: task.durationMinutes, deadlineAt: taskDeadlines.get(task.id) ?? null,
      mutable: access.mutable, mutabilityLabel: access.label,
      intent: intent ? { requiredCapacity: intent.requiredCapacity, goalAlignment: intent.goalAlignment } : null,
    };
  }).sort((a, b) => compareBytes(a.id, b.id));

  const targetKeys = new Set<string>();
  const targetPairs = value.targetEvaluations.map((target): readonly [string, PlacementTargetV1] => {
    const task = tasks.get(target.taskId), key = `${target.taskId}@${target.startAt}`;
    if (!task || targetKeys.has(key) || !within(target.startAt, dayStartAt, dayEndAt)) return invalid();
    targetKeys.add(key);
    const common = { schemaVersion: 1 as const, key, taskId: target.taskId, startAt: target.startAt, timeLabel: timeLabel(target.startAt, value.timeZone) };
    if (!target.result.ok) return [key, { ...common, status: "rejected", label: rejectionLabels[target.result.rejection], rejection: target.result.rejection }];
    const candidate = target.result.candidate;
    if (candidate.taskId !== target.taskId || candidate.startAt !== target.startAt
      || candidate.requestHash !== target.result.requestHash || !validScore(candidate) || compareInstants(candidate.endAt, dayEndAt) > 0) return invalid();
    registerCandidate(candidate, true);
    return [key, { ...common, status: "candidate", label: `Available at ${common.timeLabel}; score ${candidate.score} of 100`, candidate: cloneCandidate(candidate) }];
  }).sort(([, a], [, b]) => compareInstants(a.startAt, b.startAt) || compareBytes(a.taskId, b.taskId));
  const placementTargets = Object.fromEntries(targetPairs) as Record<string, PlacementTargetV1>;

  if (value.focusGate.nextBoundaryAt !== null && !within(value.focusGate.nextBoundaryAt, dayStartAt, dayEndAt)) return invalid();
  const gateState = !value.focusGate.enabled ? "disabled" as const : value.focusGate.evaluation.allowed ? "open" as const : "read-only" as const;
  const focusGate = {
    enabled: value.focusGate.enabled, state: gateState, allowed: value.focusGate.evaluation.allowed,
    label: gateState === "disabled" ? "Focus Gate is disabled" : gateState === "open" ? "Focus Gate is open"
      : value.focusGate.evaluation.code === "focus-gate-closed" ? "Focus Gate is closed — tasks are read-only" : invalid(),
    nextBoundaryAt: value.focusGate.nextBoundaryAt,
    nextBoundaryLabel: value.focusGate.nextBoundaryAt === null ? null : timeLabel(value.focusGate.nextBoundaryAt, value.timeZone),
  };
  const meetingWarning: MeetingWarningV1 | null = value.meetingWarning === null ? null : {
    schemaVersion: 1,
    classification: value.meetingWarning.classification,
    wording: value.meetingWarning.wording,
    occurrenceCount: value.meetingWarning.occurrenceCount,
    distinctUtcDates: value.meetingWarning.distinctUtcDates,
    newestAgeDays: value.meetingWarning.newestAgeDays,
    weightedChange: value.meetingWarning.weightedChange,
    confidence: value.meetingWarning.confidence,
    confidenceComponents: { ...value.meetingWarning.confidenceComponents },
    limitations: [...value.meetingWarning.limitations],
    explanation: value.meetingWarning.explanation,
    recovery: value.meetingWarning.recovery === null ? null : { ...value.meetingWarning.recovery },
  };
  const dashes = ["—", "—", "—", "—", "—"];
  const rows = [
    ...capacityPoints.map((point) => ["Capacity", point.timeLabel, "—", "Personal Rhythm capacity", "Personal Rhythm", point.statusLabel, point.capacity === null ? "Unknown" : String(point.capacity), `${Math.round(point.confidence * 100)}%`, ...dashes, `ESS ${point.components.effectiveSampleSize}; sample ${point.components.sampleScore}; dates ${point.components.dateScore}; freshness ${point.components.freshnessScore}`, point.limitations.join(", ") || "None"]),
    ...timeline.map((entry) => [entry.type[0]!.toUpperCase() + entry.type.slice(1), entry.startLabel, entry.endLabel, entry.title, entry.sourceLabel, entry.statusLabel, entry.score === null ? "—" : String(entry.score), entry.confidence === null ? "Unknown" : `${Math.round(entry.confidence * 100)}%`, ...(entry.breakdown === null ? dashes : [entry.breakdown.capacityFit, entry.breakdown.deadlineUrgency, entry.breakdown.goalAlignment, entry.breakdown.contextSwitch, entry.breakdown.recoverySupport].map(String)), "—", entry.limitations.join(", ") || "None"]),
    ...(meetingWarning === null ? [] : [[
      "Meeting warning", "—", "—", meetingWarning.wording, "Private personal pattern", meetingWarning.explanation,
      meetingWarning.recovery === null ? "No recovery suggested" : `${meetingWarning.recovery.minutes}-minute recovery suggested`,
      `${Math.round(meetingWarning.confidence * 100)}%`, ...dashes,
      `Occurrences ${meetingWarning.occurrenceCount}; UTC dates ${meetingWarning.distinctUtcDates}; newest age ${meetingWarning.newestAgeDays} days; count ${meetingWarning.confidenceComponents.count}; dates ${meetingWarning.confidenceComponents.distinctDates}; freshness ${meetingWarning.confidenceComponents.freshness}; weighted change ${meetingWarning.weightedChange ?? "unknown"}`,
      meetingWarning.limitations.join(", "),
    ]]),
  ];
  if (rows.length > 10_000) return invalid();
  const visualizationResult = accessibleVisualizationV1Schema.safeParse({
    schemaVersion: 1,
    title: `Today ${value.date} — revision ${value.state.revision}`,
    summary: `${focusGate.label}. ${timeline.length} timeline entries, ${backlog.length} open tasks, ${capacityPoints.length} capacity points, and ${meetingWarning === null ? 0 : 1} meeting warning.`,
    series: [
      { id: "70000000-0000-4000-8000-000000000001", label: "Capacity, with unknown values preserved", points: capacityPoints.map((point) => ({ x: point.startAt, y: point.capacity })) },
      { id: "70000000-0000-4000-8000-000000000002", label: "Task and proposal scores; status is also written in the table", points: timeline.filter((entry) => entry.score !== null).map((entry) => ({ x: entry.startAt, y: entry.score })) },
    ],
    table: { columns: ["Type", "Start", "End", "Title", "Source", "Status", "Capacity or score", "Confidence", "Capacity fit", "Deadline urgency", "Goal alignment", "Context switch", "Recovery support", "Evidence components", "Limitations"], rows },
    announcements: [
      focusGate.label,
      `${timeline.length} timeline entries and ${backlog.length} open tasks.`,
      ...(meetingWarning === null ? [] : [`${meetingWarning.wording}. ${meetingWarning.explanation} Confidence ${Math.round(meetingWarning.confidence * 100)}%. ${meetingWarning.recovery === null ? "No recovery suggested." : `Suggested recovery: ${meetingWarning.recovery.minutes} minutes.`}`]),
    ],
  });
  if (!visualizationResult.success) return invalid();
  const visualization = visualizationResult.data;
  return freeze({
    schemaVersion: 1, revision: value.state.revision, date: value.date, timeZone: value.timeZone, dayStartAt, dayEndAt,
    capacityPoints, timeline, backlog, focusGate, meetingWarning, placementTargets, visualization,
  });
};
