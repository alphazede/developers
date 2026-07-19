import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import { buildJordanTodayProjection } from "../../src/runtime/today-fixture";

const fixture = new URL("../../fixtures/jordan-lee/", import.meta.url);
const taskId = "a1000000-0000-4000-8000-000000000011";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Jordan Today runtime", () => {
  it("builds deterministic real fixture data without mutating source bytes", async () => {
    const before = await readFile(new URL("state.json", fixture), "utf8");
    const one = await buildJordanTodayProjection();
    const two = await buildJordanTodayProjection();

    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(await readFile(new URL("state.json", fixture), "utf8")).toBe(before);
    expect(one).toMatchObject({ schemaVersion: 1, revision: 1, date: "2026-07-23", timeZone: "America/Chicago" });
    expect(one.capacityPoints).toHaveLength(48);
    expect(one.capacityPoints.every((point) => {
      const minute = Temporal.Instant.from(point.startAt).toZonedDateTimeISO(one.timeZone).minute;
      return minute === 0 || minute === 30;
    })).toBe(true);
    expect(Object.keys(one.placementTargets)).toHaveLength(56);
    expect(one.backlog.find((task) => task.id === taskId)).toMatchObject({ mutable: false, intent: { requiredCapacity: 55, goalAlignment: 60 } });
    const target = one.placementTargets[`${taskId}@2026-07-23T20:30:00Z`];
    expect(target).toMatchObject({ status: "candidate", candidate: { startAt: "2026-07-23T20:30:00Z", endAt: "2026-07-23T21:00:00Z" } });
    expect(new Set(Object.values(one.placementTargets).filter((item) => item.status === "rejected").map((item) => item.rejection)))
      .toEqual(new Set(["hard-conflict", "after-deadline", "duration"]));
    expect(one.focusGate).toMatchObject({ state: "open", nextBoundaryAt: "2026-07-23T16:00:00Z" });
    expect(one.meetingWarning).toEqual({
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
      explanation: "Observational evidence only. This is a private personal pattern—not medical or causal, not a stress or toxic label, and not a judgment about any person or contact.",
      recovery: { minutes: 15, rationale: "Observational meeting-pattern history supports a recovery buffer." },
    });
    expect(Object.isFrozen(one.meetingWarning)).toBe(true);
    const serialized = JSON.stringify(one);
    for (const privateField of ["participantSetKey", "recurringSeriesRef", "sourceEntityId", "connections", "provenance", "patternKey", "seriesRef", "providerParticipantIds", "hmac", "digest"]) expect(serialized).not.toContain(privateField);
  });

  it("fails with one public-safe error when fixture integrity fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "today-fixture-"));
    try {
      await cp(fixture, directory, { recursive: true });
      const tasks = new URL(`file://${directory}/tasks.json`);
      await writeFile(tasks, `${await readFile(tasks, "utf8")} `);
      await expect(buildJordanTodayProjection(new URL(`file://${directory}/`))).rejects.toThrow("TODAY_FIXTURE_UNAVAILABLE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records 100 warmed builder samples without a flaky wall-time gate", async () => {
    await buildJordanTodayProjection();
    const samples: number[] = [];
    let digest = "";
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      digest = hash(JSON.stringify(await buildJordanTodayProjection()));
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const receipt = { iterations: 100, p50: Number(samples[49]!.toFixed(3)), p95: Number(samples[94]!.toFixed(3)), digest };
    console.info("today-builder-benchmark", JSON.stringify(receipt));
    expect(receipt).toMatchObject({ iterations: 100, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(receipt.p95).toBeLessThan(250);
  }, 15_000);
});
