import { describe, expect, it } from "vitest";

import { createRhythmCache, estimatePersonalRhythm, type RhythmInput, type RhythmObservation, type RhythmSuccess } from "../../../src/domain/rhythm";

const now = "2026-07-19T18:00:00Z";
const base = (id: string, observedAt: string, localTime: string, value = 1, reliability = 1): RhythmObservation => ({
  id, observedAt, localTime, value, reliability, immutable: true, signal: "self-report",
  provenance: { schemaVersion: 1, source: "fixture", sourceEntityId: `entity-${id}`, consentRevision: 7, freshness: { schemaVersion: 1, fetchedAt: "2026-07-19T18:00:00Z", sourceUpdatedAt: "2026-07-19T18:00:00Z", expiresAt: "2026-07-20T18:00:00Z", state: "fixture" }, importedAt: "2026-07-19T18:00:00Z" },
});
const input = (observations: readonly RhythmObservation[], extra: Partial<RhythmInput> = {}): RhythmInput => ({ observations, now, timeZone: "America/Chicago", configVersion: "rhythm-1", sourceConsents: { fixture: { revision: 7, active: true } }, buckets: [780], ...extra });
const estimate = async (value: RhythmInput, cache?: ReturnType<typeof createRhythmCache>): Promise<RhythmSuccess> => {
  const result = await estimatePersonalRhythm(value, cache);
  if (!result.ok) throw new Error(result.error.code);
  return result;
};
const invalid = async (value: unknown): Promise<void> => { await expect(estimatePersonalRhythm(value as RhythmInput)).resolves.toMatchObject({ ok: false }); };

describe("PersonalRhythm", () => {
  it("returns truthful unknown results and exact weighted results", async () => {
    expect((await estimate(input([]))).value[0]).toMatchObject({ status: "unknown", limitations: ["insufficient-effective-sample-size", "insufficient-distinct-local-dates", "no-contributing-evidence"] });
    const result = await estimate(input([
      base("a", "2026-07-19T18:00:00Z", "13:00", 1), base("b", "2026-07-18T18:00:00Z", "13:00", 1), base("c", "2026-07-17T18:00:00Z", "13:00", -1), base("d", "2026-07-16T18:00:00Z", "13:00", -1), base("e", "2026-07-15T18:00:00Z", "13:00", 0),
    ]));
    expect(result.value[0]).toMatchObject({ status: "known", capacity: 52, confidence: 0.8049, confidenceBand: "high", contributingCount: 5, distinctLocalDates: 5 });
    expect(result.value[0].components).toEqual({ effectiveSampleSize: 4.9756, sampleScore: 0.4146, dateScore: 1, freshnessScore: 1 });
  });

  it("preserves circular exclusion and raw ESS gates", async () => {
    const midnight = Array.from({ length: 5 }, (_, index) => base(`${index}`, `2026-07-${String(19 - index).padStart(2, "0")}T05:59:00Z`, "23:59"));
    expect((await estimate(input([...midnight, base("edge", "2026-07-14T07:59:00Z", "02:00"), base("zero", "2026-07-13T06:00:00Z", "00:00", 1, 0)], { buckets: [0] }))).value[0]).toMatchObject({ status: "known", contributingCount: 5, capacity: 90 });
    const boundary = await estimate(input(Array.from({ length: 4 }, (_, index) => base(`ess-${index}`, now, "13:00", 1, index === 3 ? .99995 : 1))));
    expect(boundary.value[0]).toMatchObject({ status: "unknown", components: { effectiveSampleSize: 4 } });
    expect(boundary.value[0].limitations).toContain("insufficient-effective-sample-size");
  });

  it("rejects malformed bounded shapes without throwing", async () => {
    await invalid(null); await invalid({ ...input([]), sourceConsents: null }); await invalid({ ...input([]), sourceConsents: [] });
    await invalid({ ...input([]), sourceConsents: { fixture: null } }); await invalid({ ...input([]), sourceConsents: { fixture: { revision: 7, active: "yes" } } });
    await invalid({ ...input([]), sourceConsents: { fixture: { revision: Number.MAX_SAFE_INTEGER + 1, active: true } } });
    await invalid({ ...input([]), sourceConsents: { fixture: { revision: 1.5, active: true } } });
    await invalid(input([{ ...base("a", now, "13:00"), id: "x".repeat(129) }]));
    await invalid(input([{ ...base("a", now, "13:00"), correction: 1 as never }]));
    await invalid(input([{ ...base("a", now, "13:00"), correction: "x".repeat(513) }]));
    await invalid(input([{ ...base("a", now, "13:00"), deleted: "yes" as never }]));
    await invalid(input([{ ...base("a", now, "13:00"), provenance: { ...base("a", now, "13:00").provenance, freshness: { ...base("a", now, "13:00").provenance.freshness, fetchedAt: "bad" } } }]));
    await expect(estimatePersonalRhythm(input([base("future", "2026-07-20T18:00:00Z", "13:00")]))).resolves.toMatchObject({ ok: false, error: { code: "future-evidence" } });
  });

  it("rejects duplicate IDs before they can inflate evidence", async () => {
    const observation = base("same", now, "13:00");
    await expect(estimatePersonalRhythm(input([observation, { ...observation, value: -1 }]))).resolves.toMatchObject({ ok: false, error: { code: "invalid-observation" } });
  });

  it("uses bytewise normalized identity for every cache dimension and FIFO eviction", async () => {
    const observations = [base("a", "2026-07-19T18:00:00Z", "13:00"), base("b", "2026-07-18T18:00:00Z", "13:00"), base("c", "2026-07-17T18:00:00Z", "13:00"), base("d", "2026-07-16T18:00:00Z", "13:00")], cache = createRhythmCache(2);
    const first = await estimate(input(observations), cache), hit = await estimate(input([...observations].reverse()), cache);
    expect(hit).toMatchObject({ cache: "hit", key: first.key });
    const changed = (patch: Partial<RhythmObservation>, extra: Partial<RhythmInput> = {}) => input([{ ...observations[0], ...patch }, ...observations.slice(1)], extra);
    for (const value of [
      changed({ signal: "readiness" }), changed({ correction: "corrected" }), changed({ deleted: true }), changed({ localTime: "12:59" }), changed({ observedAt: "2026-07-18T18:00:00Z" }), changed({ reliability: .9 }), changed({ value: -.5 }),
      changed({ provenance: { ...observations[0].provenance, sourceEntityId: "other" } }), changed({ provenance: { ...observations[0].provenance, consentRevision: 8 } }), changed({ provenance: { ...observations[0].provenance, importedAt: "2026-07-18T18:00:00Z" } }),
      changed({ provenance: { ...observations[0].provenance, freshness: { ...observations[0].provenance.freshness, fetchedAt: "2026-07-18T18:00:00Z" } } }),
      changed({ provenance: { ...observations[0].provenance, freshness: { ...observations[0].provenance.freshness, sourceUpdatedAt: null } } }),
      changed({ provenance: { ...observations[0].provenance, freshness: { ...observations[0].provenance.freshness, expiresAt: null } } }),
      changed({ provenance: { ...observations[0].provenance, freshness: { ...observations[0].provenance.freshness, state: "stale" } } }),
      input(observations, { now: "2026-07-19T18:01:00Z" }), input(observations, { timeZone: "America/New_York" }), input(observations, { configVersion: "rhythm-2" }), input(observations, { sourceConsents: { fixture: { revision: 8, active: true } } }), input(observations, { buckets: [781] }),
      input(observations, { sourceConsents: { fixture: { revision: 7, active: false } } }), changed({ provenance: { ...observations[0].provenance, source: "local" } }, { sourceConsents: { fixture: { revision: 7, active: true }, local: { revision: 7, active: true } } }),
    ]) expect((await estimate(value, cache)).cache).toBe("miss");
    const ordered = await estimate(input([base("a", now, "13:00"), base("z", now, "13:00")]), cache), bytewise = await estimate(input([base("z", now, "13:00"), base("a", now, "13:00")]), cache);
    expect(bytewise.key).toBe(ordered.key);
    const one = createRhythmCache(2); await estimate(input(observations), one); await estimate(input(observations, { configVersion: "two" }), one); await estimate(input(observations, { configVersion: "three" }), one);
    expect((await estimate(input(observations), one)).cache).toBe("miss");
  });

  it("preserves special consent keys as cache identity without prototype mutation", async () => {
    const observations = [base("a", now, "13:00")], cache = createRhythmCache(2);
    const consents = (revision: number) => JSON.parse(`{"fixture":{"revision":7,"active":true},"__proto__":{"revision":${revision},"active":false},"constructor":{"revision":1,"active":false},"prototype":{"revision":1,"active":false}}`) as RhythmInput["sourceConsents"];
    const firstConsents = consents(99), secondConsents = consents(100);
    const first = await estimate(input(observations, { sourceConsents: firstConsents }), cache);
    const changed = await estimate(input(observations, { sourceConsents: secondConsents }), cache);
    expect(changed.cache).toBe("miss");
    expect(changed.key).not.toBe(first.key);
    expect(Object.getPrototypeOf(firstConsents)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(secondConsents)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("revision");
  });

  it("records 100 warmed no-cache samples and a 10,000 by 48 result", async () => {
    const observations = Array.from({ length: 100 }, (_, index) => base(`${index}`, `2026-07-${String(19 - index % 14).padStart(2, "0")}T18:00:00Z`, "13:00", index % 2 ? 1 : -1));
    const fixture = input(observations, { buckets: Array.from({ length: 48 }, (_, index) => index * 30) });
    await estimate(fixture); const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) { const start = performance.now(); const result = await estimate(fixture); samples.push(performance.now() - start); expect(result.value[0].totalCount).toBe(100); }
    samples.sort((a, b) => a - b); console.info(`rhythm no-cache observations=100 buckets=48 iterations=100 p50=${samples[49]!.toFixed(3)}ms p95=${samples[94]!.toFixed(3)}ms`);
    const large = await estimate(input(Array.from({ length: 10_000 }, (_, index) => base(`large-${index}`, "2026-07-19T18:00:00Z", "13:00")), { buckets: Array.from({ length: 48 }, (_, index) => index * 30) }));
    expect(large.value).toHaveLength(48); expect(large.value[26]).toMatchObject({ totalCount: 10_000, contributingCount: 10_000 });
  }, 30_000);
});
