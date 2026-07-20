import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Temporal } from "@js-temporal/polyfill";

import { localStateV1Schema } from "../contracts/v1";
import { evaluateFocusGate } from "../domain/focus-gate";
import { analyzeMeetingLoad } from "../domain/meeting-load";
import { estimatePersonalRhythm } from "../domain/rhythm";
import {
  evaluateTarget,
  recommend,
  uuidV5,
  type CapacityBucket,
  type ScheduleInterval,
  type SchedulerInput,
} from "../domain/schedule";
import {
  buildTodayProjection,
  type DisplayCapacityPointInput,
  type MeetingWarningV1,
  type TodayProjectionV1,
} from "../ui/projections";
import { deriveMeetingPatternKey } from "../server/security/crypto";
import { FixtureAdapter } from "./fixture-adapter";

const defaultFixture = (): URL => pathToFileURL(`${resolve(process.cwd(), "fixtures/jordan-lee")}${sep}`);
const SELECTED_TASK_ID = "a1000000-0000-4000-8000-000000000011";
const RECOVERY_ID = "e5000000-0000-4000-8000-000000000003";
const CAPACITY_NAMESPACE = "urn:capacity-scheduling:capacity:v1";
const RHYTHM_CONFIG_VERSION = "jordan-today-v1";
const SYNTHETIC_MEETING_SERIES = "synthetic-jordan-meeting-pattern-v1";
const SYNTHETIC_MEETING_PARTICIPANTS = ["synthetic-participant-a", "synthetic-participant-b"] as const;
const MEETING_EXPLANATION = "Observational evidence only. This is a private personal pattern—not medical or causal, not a stress or toxic label, and not a judgment about any person or contact." as const;

// Public and deterministic by design: this seed is only for synthetic fixture analysis, never live data.
const syntheticMeetingKey = () => deriveMeetingPatternKey(
  createHash("sha256").update("capacity-scheduling:synthetic-jordan-meeting-key:v1").digest(),
);

const instantAt = (date: string, timeZone: string, minuteOfDay: number): string => {
  const time = Temporal.PlainTime.from({
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  });
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime: time }).toInstant().toString();
};

const nextFocusBoundary = (
  date: string,
  timeZone: string,
  now: string,
  windows: readonly Readonly<{ startLocalTime: string; endLocalTime: string }>[],
): string | null => {
  const boundaries = windows.flatMap(({ startLocalTime, endLocalTime }) => [startLocalTime, endLocalTime])
    .map((plainTime) => Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime }).toInstant())
    .filter((boundary) => Temporal.Instant.compare(boundary, now) > 0)
    .sort(Temporal.Instant.compare);
  return boundaries[0]?.toString() ?? null;
};

/** Builds the fixed Jordan Lee Today view from integrity-checked local fixture bytes. */
export const buildJordanTodayProjection = async (directory: URL = defaultFixture()): Promise<TodayProjectionV1> => {
  try {
    const loaded = await new FixtureAdapter("synthetic").loadFixtureDirectory(directory);
    const state = localStateV1Schema.parse(JSON.parse(loaded.stateBytes));
    const { manifest } = loaded;
    const { canonicalDay: date, fixedNow: now, persona, focusGate } = manifest;
    const { timeZone } = persona;
    if (state.timeZone !== timeZone) throw new Error("Fixture zone mismatch");

    const meetingObservations = state.observations.filter((observation) => observation.signal === "meeting-after");
    if (meetingObservations.length !== 3) throw new Error("Meeting observations unavailable");
    const meetingAnalysis = analyzeMeetingLoad(meetingObservations.map((observation) => ({
      occurrenceId: observation.id,
      occurredAt: observation.observedAt,
      seriesRef: SYNTHETIC_MEETING_SERIES,
      providerParticipantIds: SYNTHETIC_MEETING_PARTICIPANTS,
      change: observation.value,
      reliability: observation.reliability,
      source: observation.provenance.source,
      consentRevision: observation.provenance.consentRevision,
      status: observation.provenance.freshness.state === "revoked" ? "revoked" as const : "active" as const,
    })), now, syntheticMeetingKey());
    const meetingPattern = meetingAnalysis.patterns[0];
    const meetingRecovery = meetingAnalysis.recoveryInputs[0];
    if (meetingAnalysis.patterns.length !== 1 || meetingAnalysis.recoveryInputs.length !== 1 || !meetingPattern || !meetingRecovery
      || meetingPattern.classification !== "historically-demanding"
      || meetingPattern.wording !== "Historically demanding meeting pattern"
      || meetingPattern.occurrenceCount !== 3 || meetingPattern.distinctUtcDates !== 3
      || meetingPattern.newestAgeDays !== 2.8333 || meetingPattern.confidence !== 0.6659
      || meetingPattern.weightedChange !== -0.291
      || JSON.stringify(meetingPattern.confidenceComponents) !== JSON.stringify({ count: 0.6, distinctDates: 0.6, freshness: 0.7976 })
      || JSON.stringify(meetingPattern.limitations) !== JSON.stringify(["Observational evidence only."])
      || meetingRecovery.suggestedBufferMinutes !== 15 || meetingRecovery.confidence !== meetingPattern.confidence
      || meetingRecovery.rationale !== "Observational meeting-pattern history supports a recovery buffer.") {
      throw new Error("Meeting analysis contract mismatch");
    }
    const meetingWarning: MeetingWarningV1 = {
      schemaVersion: 1,
      classification: meetingPattern.classification,
      wording: meetingPattern.wording,
      occurrenceCount: meetingPattern.occurrenceCount,
      distinctUtcDates: meetingPattern.distinctUtcDates,
      newestAgeDays: meetingPattern.newestAgeDays,
      weightedChange: meetingPattern.weightedChange,
      confidence: meetingPattern.confidence,
      confidenceComponents: { ...meetingPattern.confidenceComponents },
      limitations: ["Observational evidence only."],
      explanation: MEETING_EXPLANATION,
      recovery: { minutes: meetingRecovery.suggestedBufferMinutes, rationale: meetingRecovery.rationale },
    };

    const dayEnd = Temporal.PlainDate.from(date).add({ days: 1 })
      .toZonedDateTime({ timeZone, plainTime: "00:00" }).toInstant();
    const halfHours = Array.from({ length: 48 }, (_, index) => index * 30);
    const sourceConsents = Object.fromEntries(Object.entries(state.connections).map(([source, connection]) => [
      source,
      { revision: connection.consentRevision, active: connection.freshness.state !== "revoked" },
    ]));
    const observations = state.observations.map(({ schemaVersion, ...observation }) => {
      if (schemaVersion !== 1) throw new Error("Observation contract mismatch");
      return { ...observation, immutable: true as const };
    });
    const rhythm = await estimatePersonalRhythm({
      observations,
      now,
      timeZone,
      configVersion: RHYTHM_CONFIG_VERSION,
      sourceConsents,
      buckets: halfHours,
    });
    if (!rhythm.ok || rhythm.value.length !== halfHours.length) throw new Error("Rhythm estimate unavailable");

    const displayCapacity: DisplayCapacityPointInput[] = await Promise.all(rhythm.value.map(async (estimate) => {
      const startAt = instantAt(date, timeZone, estimate.bucketMinutes);
      return {
        id: await uuidV5([CAPACITY_NAMESPACE, date, startAt]),
        startAt,
        capacity: estimate.capacity,
        confidence: estimate.confidence,
        components: { ...estimate.components },
        limitations: [...estimate.limitations],
      };
    }));

    const nowInstant = Temporal.Instant.from(now);
    const capacity: CapacityBucket[] = [];
    for (const estimate of rhythm.value) {
      for (const offset of [0, 15]) {
        const startAt = instantAt(date, timeZone, estimate.bucketMinutes + offset);
        const start = Temporal.Instant.from(startAt);
        if (Temporal.Instant.compare(start, nowInstant) < 0 || Temporal.Instant.compare(start, dayEnd) >= 0) continue;
        const known = estimate.status === "known";
        capacity.push({
          id: await uuidV5([CAPACITY_NAMESPACE, date, startAt]),
          startAt,
          capacity: known ? estimate.capacity : null,
          confidence: known ? estimate.confidence : null,
        });
      }
    }

    const intervals: ScheduleInterval[] = state.commitments.flatMap((commitment) => {
      if (!commitment.startAt || !commitment.endAt) return [];
      const start = Temporal.Instant.from(commitment.startAt);
      const end = Temporal.Instant.from(commitment.endAt);
      if (Temporal.Instant.compare(end, nowInstant) <= 0 || Temporal.Instant.compare(start, dayEnd) >= 0) return [];
      return [{
        id: commitment.id,
        startAt: Temporal.Instant.compare(start, nowInstant) < 0 ? now : commitment.startAt,
        endAt: Temporal.Instant.compare(end, dayEnd) > 0 ? dayEnd.toString() : commitment.endAt,
        kind: commitment.protected ? "protected" as const : "hard" as const,
        projectRef: null,
      }];
    });
    const recovery = {
      id: RECOVERY_ID,
      title: "Suggested recovery",
      startAt: "2026-07-23T20:00:00Z",
      endAt: "2026-07-23T20:30:00Z",
      approved: false,
    } as const;
    const softRecovery: ScheduleInterval[] = [{
      id: recovery.id,
      startAt: recovery.startAt,
      endAt: recovery.endAt,
      kind: "soft-recovery",
      projectRef: null,
    }];

    const task = state.tasks.find((item) => item.id === SELECTED_TASK_ID);
    const intent = state.schedulingIntents.find((item) => item.taskId === SELECTED_TASK_ID);
    if (!task || !intent || task.source !== "github" || task.durationMinutes !== 30
      || task.deadlineAt !== "2026-07-23T21:00:00Z" || intent.requiredCapacity !== 55 || intent.goalAlignment !== 60) {
      throw new Error("Selected task contract mismatch");
    }
    const schedulerInput: SchedulerInput = {
      schemaVersion: 1,
      sourceRevision: state.revision,
      now,
      horizonEnd: dayEnd.toString(),
      task: { id: task.id, source: task.source, immutable: true, projectRef: task.projectRef },
      durationMinutes: task.durationMinutes,
      intent: { ...intent },
      deadlineAt: task.deadlineAt,
      permission: true,
      capacity,
      intervals,
      softRecovery,
    };
    const recommendation = await recommend(schedulerInput);
    if (!recommendation.ok) throw new Error("Recommendation unavailable");

    const starts: string[] = [];
    for (let start = nowInstant; Temporal.Instant.compare(start, dayEnd) < 0; start = start.add({ minutes: 15 })) {
      starts.push(start.toString());
    }
    const targetEvaluations = await Promise.all(starts.map(async (startAt) => ({
      taskId: task.id,
      startAt,
      result: await evaluateTarget(schedulerInput, startAt),
    })));
    const deadlineTarget = targetEvaluations.find((item) => item.startAt === "2026-07-23T20:30:00Z");
    if (!deadlineTarget?.result.ok || deadlineTarget.result.candidate.endAt !== task.deadlineAt) {
      throw new Error("Deadline-equality target unavailable");
    }

    const gateEvaluation = evaluateFocusGate(
      { kind: "local-task-edit", taskSource: "local" },
      now,
      { enabled: true, timeZone, windows: focusGate.windows },
    );
    if (!gateEvaluation.ok) throw new Error("Focus Gate unavailable");

    return buildTodayProjection({
      schemaVersion: 1,
      date,
      timeZone,
      state,
      capacityPoints: displayCapacity,
      focusGate: {
        enabled: true,
        evaluation: gateEvaluation,
        nextBoundaryAt: nextFocusBoundary(date, timeZone, now, focusGate.windows),
      },
      recovery: [recovery],
      meetingWarning,
      candidates: recommendation.candidates,
      targetEvaluations,
    });
  } catch {
    throw new Error("TODAY_FIXTURE_UNAVAILABLE");
  }
};
