import { describe, expect, it } from "vitest";

import manifestJson from "../../../fixtures/jordan-lee/manifest.json";
import stateJson from "../../../fixtures/jordan-lee/state.json";
import { localStateV1Schema, type ProposalV1 } from "../../../src/contracts/v1";
import { evaluateFocusGate } from "../../../src/domain/focus-gate";
import { evaluateTarget, type SchedulerInput } from "../../../src/domain/schedule";
import {
  buildTodayProjection,
  createTargetPlacementCommand,
  type MeetingWarningV1,
  type TodayProjectionInput,
} from "../../../src/ui/projections";

const ids = {
  approved: "90000000-0000-4000-8000-000000000001",
  known: "90000000-0000-4000-8000-000000000002",
  unknown: "90000000-0000-4000-8000-000000000003",
  soft: "90000000-0000-4000-8000-000000000004",
  recovery: "90000000-0000-4000-8000-000000000005",
  command: "90000000-0000-4000-8000-000000000006",
} as const;

const fixtureState = () => localStateV1Schema.parse(structuredClone(stateJson));
const components = { effectiveSampleSize: 4.25, sampleScore: 0.5, dateScore: 0.75, freshnessScore: 1 } as const;
const meetingExplanation = "Observational evidence only. This is a private personal pattern—not medical or causal, not a stress or toxic label, and not a judgment about any person or contact." as const;
const meetingWarning: MeetingWarningV1 = {
  schemaVersion: 1,
  classification: "historically-demanding",
  wording: "Historically demanding meeting pattern",
  occurrenceCount: 3,
  distinctUtcDates: 3,
  newestAgeDays: 2.8333,
  weightedChange: -0.291,
  confidence: 0.6659,
  confidenceComponents: { count: 0.6, distinctDates: 0.6, freshness: 0.7976 },
  limitations: ["Observational evidence only."],
  explanation: meetingExplanation,
  recovery: { minutes: 15, rationale: "Observational meeting-pattern history supports a recovery buffer." },
};

const input = async (): Promise<TodayProjectionInput> => {
  const state = fixtureState();
  const task = state.tasks.find((item) => item.id === "a1000000-0000-4000-8000-000000000011")!;
  const intent = state.schedulingIntents.find((item) => item.taskId === task.id)!;
  const capacity = [
    { id: ids.known, startAt: "2026-07-23T20:30:00Z", capacity: 70, confidence: 0.8, components, limitations: [] },
    { id: ids.unknown, startAt: "2026-07-23T20:45:00Z", capacity: 55, confidence: 0.6, components, limitations: [] },
  ] as const;
  const scheduler: SchedulerInput = {
    schemaVersion: 1,
    sourceRevision: state.revision,
    now: manifestJson.fixedNow,
    horizonEnd: "2026-07-24T05:00:00Z",
    task: { id: task.id, source: task.source, immutable: true, projectRef: task.projectRef },
    durationMinutes: task.durationMinutes!,
    intent,
    deadlineAt: task.deadlineAt,
    permission: true,
    capacity: capacity.map(({ id, startAt, capacity: estimate, confidence }) => ({ id, startAt, capacity: estimate, confidence })),
    intervals: state.commitments.flatMap((item) => item.startAt && item.endAt && item.startAt >= manifestJson.fixedNow
      ? [{ id: item.id, startAt: item.startAt, endAt: item.endAt, kind: item.protected ? "protected" as const : "hard" as const }]
      : []),
    softRecovery: [],
  };
  const candidateResult = await evaluateTarget(scheduler, "2026-07-23T20:30:00Z");
  const rejection = await evaluateTarget(scheduler, "2026-07-23T19:00:00Z");
  if (!candidateResult.ok) throw new Error(candidateResult.rejection);
  const localTask = state.tasks.find((item) => item.id === "a1000000-0000-4000-8000-000000000013")!;
  const approved: ProposalV1 = {
    schemaVersion: 1, id: ids.approved, taskId: localTask.id, sourceRevision: state.revision,
    startAt: "2026-07-23T17:00:00Z", endAt: "2026-07-23T17:30:00Z", score: 87,
    breakdown: { capacityFit: 38, deadlineUrgency: 15, goalAlignment: 14, contextSwitch: 10, recoverySupport: 10 },
    confidence: 0.75, limitations: [], status: "approved",
  };
  state.proposals = [approved];
  const gate = evaluateFocusGate(
    { kind: "local-task-edit", taskSource: "local" },
    manifestJson.fixedNow,
    { enabled: true, timeZone: state.timeZone, windows: manifestJson.focusGate.windows },
  );
  if (!gate.ok) throw new Error(gate.error.code);
  return {
    schemaVersion: 1,
    date: manifestJson.canonicalDay,
    timeZone: state.timeZone,
    state,
    capacityPoints: [
      ...capacity,
      { id: "90000000-0000-4000-8000-000000000007", startAt: "2026-07-23T21:00:00Z", capacity: null, confidence: 0.3, components: { ...components, effectiveSampleSize: 2.5 }, limitations: ["capacity_unknown"] },
    ],
    focusGate: { enabled: true, evaluation: gate, nextBoundaryAt: "2026-07-23T16:00:00Z" },
    recovery: [
      { id: ids.soft, title: "Suggested recovery", startAt: "2026-07-23T20:00:00Z", endAt: "2026-07-23T20:15:00Z", approved: false },
      { id: ids.recovery, title: "Approved recovery", startAt: "2026-07-23T20:15:00Z", endAt: "2026-07-23T20:30:00Z", approved: true },
    ],
    meetingWarning,
    candidates: [candidateResult.candidate],
    targetEvaluations: [
      { taskId: task.id, startAt: "2026-07-23T20:30:00Z", result: candidateResult },
      { taskId: task.id, startAt: "2026-07-23T19:00:00Z", result: rejection },
    ],
  };
};

describe("TodayProjection", () => {
  it("projects the corrected Jordan day without private source state", async () => {
    const projection = buildTodayProjection(await input());
    expect(projection).toMatchObject({
      schemaVersion: 1, date: "2026-07-23", timeZone: "America/Chicago", revision: 1,
      dayStartAt: "2026-07-23T05:00:00Z", dayEndAt: "2026-07-24T05:00:00Z",
      focusGate: { state: "open", nextBoundaryAt: "2026-07-23T16:00:00Z" },
    });
    expect(projection.backlog).toHaveLength(4);
    expect(projection.backlog.find((task) => task.source === "github")).toMatchObject({
      intent: { requiredCapacity: 55, goalAlignment: 60 }, mutable: false,
    });
    expect(new Set(projection.timeline.map((entry) => entry.type))).toEqual(new Set(["hard", "protected", "recovery", "task", "proposal"]));
    expect(projection.capacityPoints.map((point) => point.status)).toEqual(["known", "known", "unknown"]);
    const target = projection.placementTargets["a1000000-0000-4000-8000-000000000011@2026-07-23T20:30:00Z"]!;
    expect(target).toMatchObject({ status: "candidate", candidate: { endAt: "2026-07-23T21:00:00Z", confidence: 0.6 } });
    expect(projection.placementTargets["a1000000-0000-4000-8000-000000000011@2026-07-23T19:00:00Z"]).toMatchObject({ status: "rejected", rejection: "hard-conflict" });
    expect(projection.visualization.table.rows.length).toBe(projection.capacityPoints.length + projection.timeline.length + 1);
    expect(projection.visualization.series[0]!.points).toEqual(projection.capacityPoints.map(({ startAt, capacity }) => ({ x: startAt, y: capacity })));
    expect(projection.visualization.table.rows.flat().join(" ")).toMatch(/Known|Unknown|Hard|Protected|Soft|Approved|Preview/);
    expect(projection.meetingWarning).toEqual(meetingWarning);
    const json = JSON.stringify(projection);
    expect(json).not.toContain("participantSetKey");
    expect(json).not.toContain("recurringSeriesRef");
    expect(json).not.toContain("sourceEntityId");
    expect(json).not.toContain("0eb768080a293a429e1d1b382a6a6aa6cb76123ca5e38e98ccb9b3ca8792234a");
  });

  it("projects one strict redacted meeting warning into equivalent accessible text", async () => {
    const projection = buildTodayProjection(await input());
    const warning = projection.meetingWarning!;
    expect(Object.keys(warning)).toEqual([
      "schemaVersion", "classification", "wording", "occurrenceCount", "distinctUtcDates", "newestAgeDays",
      "weightedChange", "confidence", "confidenceComponents", "limitations", "explanation", "recovery",
    ]);
    expect(warning).toEqual(meetingWarning);
    expect(Object.isFrozen(warning)).toBe(true);
    expect(Object.isFrozen(warning.confidenceComponents)).toBe(true);
    expect(Object.isFrozen(warning.limitations)).toBe(true);
    expect(Object.isFrozen(warning.recovery)).toBe(true);

    const row = projection.visualization.table.rows.find((item) => item[0] === "Meeting warning")!;
    expect(row).toEqual([
      "Meeting warning", "—", "—", warning.wording, "Private personal pattern", warning.explanation,
      "15-minute recovery suggested", "67%", "—", "—", "—", "—", "—",
      "Occurrences 3; UTC dates 3; newest age 2.8333 days; count 0.6; dates 0.6; freshness 0.7976; weighted change -0.291",
      "Observational evidence only.",
    ]);
    const announcement = projection.visualization.announcements.find((item) => item.startsWith(warning.wording))!;
    expect(announcement).toBe(`${warning.wording}. ${warning.explanation} Confidence 67%. Suggested recovery: 15 minutes.`);

    const serialized = JSON.stringify(warning);
    expect(serialized).not.toMatch(/patternKey|series|participant|sourceEntity|personId|contactId|hmac|digest/i);
    expect(serialized).not.toContain("0eb768080a293a429e1d1b382a6a6aa6cb76123ca5e38e98ccb9b3ca8792234a");
  });

  it("rejects meeting-warning identity fields, unapproved copy, and contradictory recovery", async () => {
    const value = await input();
    const invalid = [
      { ...meetingWarning, classification: "neutral" },
      { ...meetingWarning, wording: "Neutral meeting pattern" },
      { ...meetingWarning, recovery: null },
      { ...meetingWarning, explanation: "This person causes stress." },
      { ...meetingWarning, limitations: ["Toxic contact."] },
      { ...meetingWarning, patternKey: "a".repeat(64) },
      { ...meetingWarning, seriesRef: "private-series" },
      { ...meetingWarning, providerParticipantIds: ["private-contact"] },
      { ...meetingWarning, recovery: { minutes: 30, rationale: meetingWarning.recovery!.rationale } },
      { ...meetingWarning, recovery: { minutes: 15, rationale: "Medical recovery required." } },
      { ...meetingWarning, distinctUtcDates: 4 },
    ];
    for (const warning of invalid) {
      expect(() => buildTodayProjection({ ...value, meetingWarning: warning as MeetingWarningV1 }))
        .toThrowError(new RangeError("INVALID_TODAY_PROJECTION"));
    }

    const neutral: MeetingWarningV1 = {
      ...meetingWarning,
      classification: "neutral",
      wording: "Neutral meeting pattern",
      recovery: null,
    };
    expect(buildTodayProjection({ ...value, meetingWarning: neutral }).meetingWarning).toEqual(neutral);
    expect(buildTodayProjection({ ...value, meetingWarning: null }).meetingWarning).toBeNull();
  });

  it("is permutation-stable and does not mutate input", async () => {
    const original = await input();
    const before = structuredClone(original);
    const permuted: TodayProjectionInput = {
      ...structuredClone(original),
      state: { ...structuredClone(original.state), tasks: [...original.state.tasks].reverse(), schedulingIntents: [...original.state.schedulingIntents].reverse(), commitments: [...original.state.commitments].reverse() },
      capacityPoints: [...original.capacityPoints].reverse(), recovery: [...original.recovery].reverse(),
      candidates: [...original.candidates].reverse(), targetEvaluations: [...original.targetEvaluations].reverse(),
    };
    const one = buildTodayProjection(original), two = buildTodayProjection(permuted);
    expect(two).toEqual(one);
    expect(original).toEqual(before);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.timeline)).toBe(true);
    expect(Object.isFrozen(one.timeline[0])).toBe(true);
  });

  it("shows read-only Focus Gate and exact unknown evidence", async () => {
    const value = await input();
    const projection = buildTodayProjection({ ...value, focusGate: { enabled: true, evaluation: { ok: true, allowed: false, code: "focus-gate-closed" }, nextBoundaryAt: "2026-07-23T19:00:00Z" } });
    expect(projection.focusGate).toMatchObject({ state: "read-only", label: "Focus Gate is closed — tasks are read-only" });
    expect(projection.capacityPoints.at(-1)).toMatchObject({ capacity: null, confidence: 0.3, status: "unknown", components: { effectiveSampleSize: 2.5 } });
    expect(projection.visualization.table.rows.flat().join(" ")).toContain("30%");
  });

  it("requires byte-equivalent reused candidates and one scheduler request hash", async () => {
    const value = await input(), target = value.targetEvaluations[0]!;
    if (!target.result.ok) throw new Error(target.result.rejection);
    const changed = { ...target.result.candidate, endAt: "2026-07-23T20:45:00Z" };
    const wrongHash = { ...target.result.candidate, id: "90000000-0000-4000-8000-000000000008", requestHash: "b".repeat(64) };
    const collision = { ...target.result.candidate, id: ids.recovery };
    const invalid: TodayProjectionInput[] = [
      { ...value, targetEvaluations: [{ ...target, result: { ...target.result, candidate: changed } }] },
      { ...value, targetEvaluations: [{ ...target, result: { ok: true, requestHash: wrongHash.requestHash, candidate: wrongHash } }] },
      { ...value, candidates: [], targetEvaluations: [{ ...target, result: { ...target.result, candidate: collision } }] },
    ];
    for (const item of invalid) expect(() => buildTodayProjection(item)).toThrowError(new RangeError("INVALID_TODAY_PROJECTION"));
    expect(buildTodayProjection(value).placementTargets[`${target.taskId}@${target.startAt}`]).toMatchObject({ status: "candidate", candidate: target.result.candidate });
  });

  it("rejects inconsistent score, confidence, capacity, and source-revision semantics", async () => {
    const value = await input(), proposal = value.state.proposals[0]!, ranked = value.candidates[0]!;
    const invalid: TodayProjectionInput[] = [
      { ...value, state: { ...value.state, proposals: [{ ...proposal, breakdown: { ...proposal.breakdown, capacityFit: 41, recoverySupport: 7 } }] } },
      { ...value, state: { ...value.state, proposals: [{ ...proposal, sourceRevision: value.state.revision + 1 }] } },
      { ...value, state: { ...value.state, proposals: [{ ...proposal, confidence: null }] } },
      { ...value, candidates: [{ ...ranked, confidence: null }], targetEvaluations: [] },
      { ...value, capacityPoints: value.capacityPoints.map((point, index) => index === 0 ? { ...point, limitations: ["capacity_unknown"] } : point) },
    ];
    for (const item of invalid) expect(() => buildTodayProjection(item)).toThrowError(new RangeError("INVALID_TODAY_PROJECTION"));
    expect(buildTodayProjection({ ...value, state: { ...value.state, revision: 2 } }).timeline.find((entry) => entry.id === proposal.id)).toMatchObject({ status: "approved" });
  });

  it("canonicalizes exposed local-state instants", async () => {
    const value = await input(), taskId = "a1000000-0000-4000-8000-000000000011", commitmentId = "b2000000-0000-4000-8000-000000000016";
    const state = structuredClone(value.state);
    state.tasks.find((task) => task.id === taskId)!.deadlineAt = "2026-07-23T21:00:00.000Z";
    const commitment = state.commitments.find((item) => item.id === commitmentId)!;
    commitment.startAt = "2026-07-23T19:00:00.000Z"; commitment.endAt = "2026-07-23T19:30:00.000Z";
    state.proposals[0]!.startAt = "2026-07-23T17:00:00.000Z"; state.proposals[0]!.endAt = "2026-07-23T17:30:00.000Z";
    const projection = buildTodayProjection({ ...value, state });
    expect(projection.backlog.find((task) => task.id === taskId)?.deadlineAt).toBe("2026-07-23T21:00:00Z");
    expect(projection.timeline.find((entry) => entry.id === commitmentId)).toMatchObject({ startAt: "2026-07-23T19:00:00Z", endAt: "2026-07-23T19:30:00Z" });
    expect(projection.timeline.find((entry) => entry.id === ids.approved)).toMatchObject({ startAt: "2026-07-23T17:00:00Z", endAt: "2026-07-23T17:30:00Z" });
  });

  it("uses offset-bearing, boundary-dated labels across the fall-back day", async () => {
    const value = await input(), state = structuredClone(value.state), crossing = structuredClone(state.commitments[0]!);
    crossing.startAt = "2026-11-01T04:30:00Z"; crossing.endAt = "2026-11-01T05:30:00Z"; crossing.deadlineAt = null;
    state.commitments = [crossing]; state.proposals = [];
    const projection = buildTodayProjection({
      ...value, date: "2026-11-01", state,
      capacityPoints: [
        { ...value.capacityPoints[0]!, startAt: "2026-11-01T06:30:00Z" },
        { ...value.capacityPoints[1]!, startAt: "2026-11-01T07:30:00Z" },
      ],
      focusGate: { enabled: false, evaluation: { ok: true, allowed: true }, nextBoundaryAt: null },
      recovery: [], candidates: [], targetEvaluations: [],
    });
    expect(projection).toMatchObject({ dayStartAt: "2026-11-01T05:00:00Z", dayEndAt: "2026-11-02T06:00:00Z" });
    expect(projection.capacityPoints.map((point) => point.timeLabel)).toEqual(["01:30 -05:00", "01:30 -06:00"]);
    expect(projection.timeline[0]).toMatchObject({ startLabel: "2026-10-31 23:30 -05:00", endLabel: "2026-11-01 00:30 -05:00" });
  });

  it("keeps every score component in the accessible semantic table", async () => {
    const projection = buildTodayProjection(await input()), entry = projection.timeline.find((item) => item.id === ids.approved)!;
    const row = projection.visualization.table.rows.find((item) => item[3] === entry.title && item[1] === entry.startLabel)!;
    expect(projection.visualization.table.columns.slice(8, 13)).toEqual(["Capacity fit", "Deadline urgency", "Goal alignment", "Context switch", "Recovery support"]);
    expect(row.slice(8, 13)).toEqual(["38", "15", "14", "10", "10"]);
    expect(row.at(-2)).toBe("—"); expect(row.at(-1)).toBe("None");
  });

  it("fails generically before the accessible visualization exceeds its row bound", async () => {
    const value = await input(), proposal = value.state.proposals[0]!;
    const proposals = Array.from({ length: 9_995 }, (_, index) => ({ ...proposal, id: `80000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    expect(() => buildTodayProjection({ ...value, state: { ...value.state, proposals } })).toThrowError(new RangeError("INVALID_TODAY_PROJECTION"));
  });

  it("rejects contradictory Focus Gate states", async () => {
    const value = await input();
    const invalid = [
      { enabled: false, evaluation: { ok: true as const, allowed: false, code: "focus-gate-closed" as const }, nextBoundaryAt: null },
      { enabled: false, evaluation: { ok: true as const, allowed: true, code: "focus-gate-closed" as const }, nextBoundaryAt: null },
      { enabled: true, evaluation: { ok: true as const, allowed: true, code: "focus-gate-closed" as const }, nextBoundaryAt: null },
      { enabled: true, evaluation: { ok: true as const, allowed: false }, nextBoundaryAt: null },
      { enabled: true, evaluation: { ok: true as const, allowed: false, code: "imported-task-immutable" as const }, nextBoundaryAt: null },
    ];
    for (const focusGate of invalid) expect(() => buildTodayProjection({ ...value, focusGate })).toThrowError(new RangeError("INVALID_TODAY_PROJECTION"));
    expect(buildTodayProjection({ ...value, focusGate: { enabled: false, evaluation: { ok: true, allowed: true }, nextBoundaryAt: null } }).focusGate.state).toBe("disabled");
  });

  it("fails closed for duplicate, orphaned, inverted, and unbounded input", async () => {
    const value = await input();
    const invalid: TodayProjectionInput[] = [
      { ...value, capacityPoints: [value.capacityPoints[0]!, value.capacityPoints[0]!] },
      { ...value, targetEvaluations: [{ ...value.targetEvaluations[0]!, taskId: "90000000-0000-4000-8000-000000000099" }] },
      { ...value, recovery: [{ ...value.recovery[0]!, endAt: value.recovery[0]!.startAt }] },
      { ...value, capacityPoints: Array.from({ length: 101 }, (_, index) => ({ id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`, startAt: `2026-07-23T${String(5 + Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}:00Z`, capacity: null, confidence: 0.3, components, limitations: [] })) },
    ];
    for (const item of invalid) expect(() => buildTodayProjection(item)).toThrowError(new RangeError("INVALID_TODAY_PROJECTION"));
  });
});

describe("TargetPlacementCommand", () => {
  it("creates one immutable authority-free command for every control path", () => {
    const value = { schemaVersion: 1 as const, commandId: ids.command, taskId: "a1000000-0000-4000-8000-000000000011", sourceRevision: 1, proposalRevision: 0, targetAt: "2026-07-23T20:30:00Z" };
    const pointer = createTargetPlacementCommand(value);
    expect(createTargetPlacementCommand({ ...value })).toEqual(pointer);
    expect(createTargetPlacementCommand(structuredClone(value))).toEqual(pointer);
    expect(Object.keys(pointer)).toEqual(["schemaVersion", "commandId", "taskId", "sourceRevision", "proposalRevision", "targetAt"]);
    expect(Object.isFrozen(pointer)).toBe(true);
    expect(() => createTargetPlacementCommand({ ...value, targetAt: "2026-07-23T20:30:00-05:00" })).toThrowError("INVALID_TARGET_PLACEMENT_COMMAND");
    expect(() => createTargetPlacementCommand({ ...value, approval: true } as typeof value)).toThrowError("INVALID_TARGET_PLACEMENT_COMMAND");
  });
});
