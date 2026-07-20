import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { deriveMeetingPatternKey, identifyDataKey } from "../../../src/server/security/crypto";
import { analyzeMeetingLoad, transitionMeetingLoad, type MeetingOccurrenceInput } from "../../../src/domain/meeting-load";

const key = deriveMeetingPatternKey(identifyDataKey(Buffer.alloc(32, 7)).key);
const now = "2026-07-23T15:00:00Z";
const occurrence = (n: number, occurredAt: string, change = -0.3, overrides: Partial<MeetingOccurrenceInput> = {}): MeetingOccurrenceInput => ({
  occurrenceId: `opaque-occurrence-${n}`,
  occurredAt,
  seriesRef: "opaque-series",
  providerParticipantIds: ["provider-b", "provider-a"],
  change,
  reliability: 1,
  source: "calendar-a",
  consentRevision: 1,
  status: "active",
  ...overrides,
});
const vector = (change = -0.3, overrides: Partial<MeetingOccurrenceInput> = {}) => [
  occurrence(1, "2026-07-17T12:00:00Z", change, overrides),
  occurrence(2, "2026-07-15T12:00:00Z", change, overrides),
  occurrence(3, "2026-07-13T12:00:00Z", change, overrides),
];
const round = (value: number) => Number(value.toFixed(4));
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/jordan-lee/observations.json", import.meta.url), "utf8")) as Array<{
  observedAt: string; value: number; reliability: number; signal: string; provenance: { source: string; consentRevision: number };
}>;
const jordanObservations = fixture.filter((item) => item.signal === "meeting-after");
const jordanOccurrences = jordanObservations.map((item, index) => occurrence(index + 1, item.observedAt, item.value, {
  reliability: item.reliability,
  source: item.provenance.source,
  consentRevision: item.provenance.consentRevision,
}));

describe("private meeting-load intelligence", () => {
  it("uses the corrected Jordan fixture and exact fractional-day design results", () => {
    expect(jordanObservations.map(({ observedAt, value, reliability }) => ({ observedAt, value, reliability }))).toEqual([
      { observedAt: "2026-07-09T19:00:00Z", value: -0.35, reliability: 0.9 },
      { observedAt: "2026-07-14T19:00:00Z", value: -0.3, reliability: 0.9 },
      { observedAt: "2026-07-20T19:00:00Z", value: -0.25, reliability: 0.9 },
    ]);
    expect(jordanOccurrences).toEqual(expect.arrayContaining(jordanObservations.map((item) => expect.objectContaining({
      occurredAt: item.observedAt, change: item.value, reliability: item.reliability, source: item.provenance.source, consentRevision: item.provenance.consentRevision,
    }))));
    expect(jordanOccurrences.map((item) => round((Date.parse(now) - Date.parse(item.occurredAt)) / 86_400_000))).toEqual([13.8333, 8.8333, 2.8333]);

    const result = analyzeMeetingLoad(jordanOccurrences, now, key);
    expect(result.patterns).toEqual([expect.objectContaining({
      classification: "historically-demanding", wording: "Historically demanding meeting pattern", occurrenceCount: 3,
      distinctUtcDates: 3, newestAgeDays: 2.8333, confidence: 0.6659, weightedChange: -0.291,
      confidenceComponents: { count: 0.6, distinctDates: 0.6, freshness: 0.7976 },
    })]);
    expect(result.patterns[0]!.weightedChange!.toFixed(4)).toBe("-0.2910");
    expect(result.patterns[0]!.patternKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/opaque-occurrence|opaque-series|provider-a|provider-b/);
  });

  it("holds count, confidence, and demand thresholds on both sides without rounding decisions", () => {
    expect(analyzeMeetingLoad(vector().slice(0, 2), now, key).patterns[0]!.classification).toBe("unknown");
    const atConfidence = [
      occurrence(1, "2026-07-15T22:12:00Z"),
      occurrence(2, "2026-07-14T22:12:00Z"),
      occurrence(3, "2026-07-13T22:12:00Z"),
    ];
    const belowConfidence = [{ ...atConfidence[0]!, occurredAt: "2026-07-15T22:11:59.999Z" }, atConfidence[1]!, atConfidence[2]!];
    expect(analyzeMeetingLoad(atConfidence, now, key).patterns[0]).toMatchObject({ confidence: 0.55, classification: "historically-demanding" });
    expect(analyzeMeetingLoad(belowConfidence, now, key).patterns[0]).toMatchObject({ confidence: 0.55, classification: "unknown" });
    expect(analyzeMeetingLoad(vector(-0.249999), now, key).patterns[0]).toMatchObject({ weightedChange: -0.25, classification: "neutral" });
    expect(analyzeMeetingLoad(vector(-0.25), now, key).patterns[0]!.classification).toBe("historically-demanding");
  });

  it("rejects duplicate, malformed, future, and noncanonical occurrence boundaries", () => {
    expect(() => analyzeMeetingLoad([occurrence(1, "2026-07-17T12:00:00Z"), occurrence(1, "2026-07-15T12:00:00Z"), occurrence(3, "2026-07-13T12:00:00Z")], now, key)).toThrow("INVALID_MEETING_LOAD_INPUT");
    for (const consentRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(() => analyzeMeetingLoad(vector(-0.3, { consentRevision } as unknown as Partial<MeetingOccurrenceInput>), now, key)).toThrow("INVALID_MEETING_LOAD_INPUT");
    }
    for (const occurredAt of ["2026-07-17T12:00:00.000Z", "2026-07-17T12:00:00.100Z", "2026-07-17T12:00:00.010Z", "2026-07-17T12:00:00+00:00", "2026-02-30T12:00:00Z", "2026-07-17T12:00:00.0000Z", "2026-07-17T12:00:00.1234567890Z", "not-an-instant"]) {
      expect(() => analyzeMeetingLoad([occurrence(1, occurredAt)], now, key)).toThrow("INVALID_MEETING_LOAD_INPUT");
    }
    expect(analyzeMeetingLoad([occurrence(1, "2026-07-17T12:00:00.123456789Z")], now, key).patterns).toHaveLength(1);
    expect(() => analyzeMeetingLoad([occurrence(1, "2026-07-23T15:00:00.001Z")], now, key)).toThrow("INVALID_MEETING_LOAD_INPUT");
  });

  it("excludes zero-reliability and revoked evidence from every derived field", () => {
    expect(analyzeMeetingLoad(vector(-0.4, { reliability: 0 }), now, key).patterns).toEqual([]);
    expect(analyzeMeetingLoad(vector(-0.4, { status: "revoked" }), now, key).patterns).toEqual([]);
    const result = analyzeMeetingLoad([...vector(-0.4), occurrence(4, "2026-07-22T12:00:00Z", 1, { reliability: 0, source: "zero-source" })], now, key);
    expect(result.patterns[0]).toMatchObject({ occurrenceCount: 3, distinctUtcDates: 3, weightedChange: -0.4 });
    expect(result.state.sources[result.patterns[0]!.patternKey]).toEqual(["calendar-a"]);
  });

  it("is permutation stable, keeps digests private, and uses only approved wording", () => {
    const first = analyzeMeetingLoad(vector(), now, key);
    expect(analyzeMeetingLoad([...vector()].reverse(), now, key)).toEqual(first);
    expect(analyzeMeetingLoad(vector(undefined, { providerParticipantIds: ["provider-a", "provider-b"] }), now, key).patterns[0]!.patternKey).toBe(first.patterns[0]!.patternKey);
    try { analyzeMeetingLoad([occurrence(1, "bad", -0.3, { seriesRef: "secret-series", providerParticipantIds: ["secret-participant"] })], now, key); } catch (error) {
      expect(String(error)).not.toMatch(/secret-series|secret-participant|opaque-occurrence/);
    }
    expect(JSON.stringify(first)).not.toMatch(/stressful|toxic|bad relationship|caus|surveillance|diagnos|medical|person/i);
    expect(() => analyzeMeetingLoad(Array.from({ length: 2001 }, (_, index) => occurrence(index, "2026-07-17T12:00:00Z")), now, key)).toThrow("INVALID_MEETING_LOAD_INPUT");
  });

  it("returns a non-authoritative recovery input and preserves complete unrelated dependent state", () => {
    const other = vector(-0.3, { seriesRef: "other-series", source: "calendar-b" }).map((item) => ({ ...item, occurrenceId: `other-${item.occurrenceId}` }));
    const analysis = analyzeMeetingLoad([...vector(), ...other], now, key);
    const first = analysis.patterns.find((pattern) => analysis.state.sources[pattern.patternKey]!.includes("calendar-a"));
    const second = analysis.patterns.find((pattern) => analysis.state.sources[pattern.patternKey]!.includes("calendar-b"));
    const confirmed = transitionMeetingLoad(analysis.state, { kind: "confirm", patternKey: first!.patternKey });
    const rejected = transitionMeetingLoad(confirmed, { kind: "reject", patternKey: second!.patternKey });
    expect(rejected).toMatchObject({ revision: 2, feedback: [{ patternKey: first!.patternKey, disposition: "confirm" }, { patternKey: second!.patternKey, disposition: "reject" }] });
    const state = {
      ...rejected,
      proposals: [{ patternKey: first!.patternKey }, { patternKey: second!.patternKey }],
      explanations: [{ patternKey: first!.patternKey }, { patternKey: second!.patternKey }],
    };
    expect(analysis.recoveryInputs).toEqual(expect.arrayContaining([expect.objectContaining({ suggestedBufferMinutes: 15, rationale: "Observational meeting-pattern history supports a recovery buffer." })]));
    const patternForgotten = transitionMeetingLoad(state, { kind: "forget-pattern", patternKey: first!.patternKey });
    expect(patternForgotten).toMatchObject({ revision: 3, patterns: [second], feedback: [{ patternKey: second!.patternKey, disposition: "reject" }], proposals: [{ patternKey: second!.patternKey }], explanations: [{ patternKey: second!.patternKey }], sources: { [second!.patternKey]: ["calendar-b"] } });
    const forgotten = transitionMeetingLoad(state, { kind: "forget-source", source: "calendar-a" });
    expect(forgotten.revision).toBe(3);
    expect(forgotten.patterns).toEqual([second]);
    expect(forgotten.feedback).toEqual([{ patternKey: second!.patternKey, disposition: "reject" }]);
    expect(forgotten.recoveryInputs).toEqual([{ patternKey: second!.patternKey, suggestedBufferMinutes: 15, confidence: second!.confidence, rationale: "Observational meeting-pattern history supports a recovery buffer." }]);
    expect(forgotten.proposals).toEqual([{ patternKey: second!.patternKey }]);
    expect(forgotten.explanations).toEqual([{ patternKey: second!.patternKey }]);
    expect(forgotten.sources).toEqual({ [second!.patternKey]: ["calendar-b"] });
    expect(transitionMeetingLoad(state, { kind: "key-rotation" })).toMatchObject({ revision: 3, patterns: [], feedback: [], recoveryInputs: [], proposals: [], explanations: [], sources: {} });
    expect(() => transitionMeetingLoad({ ...state, proposals: [{ patternKey: "f".repeat(64) }] }, { kind: "key-loss" })).toThrow("INVALID_MEETING_LOAD_INPUT");
  });
});
