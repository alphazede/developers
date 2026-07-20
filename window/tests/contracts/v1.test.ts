import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  fixtureManifestV1Schema,
  localStateV1Schema,
  normalizedTaskV1Schema,
  schedulingIntentV1Schema,
  domainEventV1Schema,
} from "../../src/contracts/v1";
import { FixtureAdapter } from "../../src/runtime/fixture-adapter";
import { ReleaseBoundary } from "../../src/runtime/release-boundary";
import { loadRuntimeMode } from "../../src/runtime/runtime-mode";

const manifestPath = new URL("../../fixtures/jordan-lee/manifest.json", import.meta.url);
const tasksPath = new URL("../../fixtures/jordan-lee/tasks.json", import.meta.url);
const commitmentsPath = new URL("../../fixtures/jordan-lee/commitments.json", import.meta.url);
const observationsPath = new URL("../../fixtures/jordan-lee/observations.json", import.meta.url);
const statePath = new URL("../../fixtures/jordan-lee/state.json", import.meta.url);
const recommendationsPath = new URL("../../fixtures/jordan-lee/recommendations.json", import.meta.url);
const packagePath = new URL("../../package.json", import.meta.url);
const fixtureDirectory = new URL("../../fixtures/jordan-lee/", import.meta.url);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("V1 contracts", () => {
  it("parses the deterministic Jordan Lee manifest", async () => {
    const manifest = fixtureManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );

    expect(manifest.persona).toEqual({
      id: "2d2882d0-6c16-4e0a-b5b6-4d2d6f604110",
      displayName: "Jordan Lee",
      timeZone: "America/Chicago",
    });
    expect(manifest.focusGate.windows).toHaveLength(2);

    const adapter = new FixtureAdapter("synthetic");
    await expect(adapter.loadTasks(await readFile(tasksPath, "utf8"))).toHaveLength(14);
    await expect(adapter.loadCommitments(await readFile(commitmentsPath, "utf8"))).toHaveLength(19);
    await expect(adapter.loadObservations(await readFile(observationsPath, "utf8"))).toHaveLength(14);
  });

  it("preserves source semantics, private meeting grouping, and complete golden state", async () => {
    const adapter = new FixtureAdapter();
    const tasks = adapter.loadTasks(await readFile(tasksPath, "utf8"));
    const commitments = adapter.loadCommitments(await readFile(commitmentsPath, "utf8"));
    const observations = adapter.loadObservations(await readFile(observationsPath, "utf8"));
    const state = localStateV1Schema.parse(JSON.parse(await readFile(statePath, "utf8")));
    const recommendations = JSON.parse(await readFile(recommendationsPath, "utf8"));

    expect(tasks.every((task) => task.source === task.provenance.source)).toBe(true);
    expect(tasks.filter((task) => ["github", "linear"].includes(task.source)).every((task) => task.immutable)).toBe(true);
    expect(tasks.filter((task) => ["local", "fixture"].includes(task.source)).every((task) => !task.immutable)).toBe(true);

    expect(commitments.filter((item) => item.kind === "selected-email-commitment").every((item) => item.provenance.source === "gmail")).toBe(true);
    expect(commitments.every((item) => ["google-calendar", "microsoft", "ics", "fixture", "local", "gmail"].includes(item.provenance.source))).toBe(true);
    expect(commitments.every((item) => item.provenance.source === "gmail"
      ? item.kind === "selected-email-commitment"
      : ["calendar-event", "protected-time"].includes(item.kind))).toBe(true);
    expect(commitments.filter((item) => item.kind === "selected-email-commitment").every((item) => item.startAt === null && item.endAt === null)).toBe(true);
    expect(commitments.filter((item) => item.participantSetKey !== null).every((item) => /^[a-f0-9]{64}$/.test(item.participantSetKey!))).toBe(true);
    const recurring = commitments.filter((item) => item.recurringSeriesRef === "series-demanding-sync");
    expect(recurring).toHaveLength(3);
    expect(new Set(recurring.map((item) => item.participantSetKey)).size).toBe(1);

    expect(observations.filter((item) => item.provenance.source === "strava").every((item) => item.signal === "activity")).toBe(true);
    expect(observations.filter((item) => item.provenance.source === "oura").every((item) => item.signal === "readiness")).toBe(true);
    expect(observations.filter((item) => ["github", "linear"].includes(item.provenance.source)).every((item) => item.signal === "task-outcome")).toBe(true);
    expect(observations.filter((item) => item.signal === "readiness").map((item) => item.value)).toEqual([0.68, 0.52, 0.4]);
    const meetingAfter = observations.filter((item) => item.signal === "meeting-after");
    expect(meetingAfter.map((item) => item.value)).toEqual([-0.35, -0.3, -0.25]);
    expect(meetingAfter.reduce((sum, item) => sum + item.value * item.reliability, 0)
      / meetingAfter.reduce((sum, item) => sum + item.reliability, 0)).toBeLessThanOrEqual(-0.25);
    expect(observations.map((item) => item.observedAt.slice(0, 10))).toEqual(Array.from({ length: 14 }, (_, index) => `2026-07-${String(index + 9).padStart(2, "0")}`));
    expect(new Set([...tasks.map((item) => item.provenance.source), ...commitments.map((item) => item.provenance.source), ...observations.map((item) => item.provenance.source)])).toEqual(new Set(["local", "fixture", "google-calendar", "gmail", "github", "linear", "microsoft", "strava", "oura", "ics"]));
    expect(commitments.some((item) => item.protected && item.title === "Protected workout")).toBe(true);
    expect(commitments.some((item) => item.protected && item.title === "Protected partner time")).toBe(true);
    expect(state.tasks).toEqual(tasks);
    expect(state.commitments).toEqual(commitments);
    expect(state.observations).toEqual(observations);
    expect(state.schedulingIntents).toEqual([
      { schemaVersion: 1, taskId: "a1000000-0000-4000-8000-000000000011", requiredCapacity: 55, goalAlignment: 60 },
      { schemaVersion: 1, taskId: "a1000000-0000-4000-8000-000000000012", requiredCapacity: 75, goalAlignment: 75 },
      { schemaVersion: 1, taskId: "a1000000-0000-4000-8000-000000000013", requiredCapacity: 85, goalAlignment: 90 },
      { schemaVersion: 1, taskId: "a1000000-0000-4000-8000-000000000014", requiredCapacity: 35, goalAlignment: 45 },
    ]);
    expect(state.schedulingIntents.map((intent) => intent.taskId)).toEqual(tasks.filter((task) => task.state === "open").map((task) => task.id));
    expect(recommendations.expectedOutcomes.map((item: { kind: string }) => item.kind)).toEqual([
      "stronger-morning-deep-work",
      "lower-capacity-administration",
      "recovery-buffer",
      "protected-commitment",
      "immutable-imported-task-placement",
    ]);
    const fixedNow = Date.parse("2026-07-23T15:00:00Z");
    const outcomes = recommendations.expectedOutcomes;
    expect(outcomes.every((outcome: { startAt: string }) => Date.parse(outcome.startAt) >= fixedNow)).toBe(true);
    expect(outcomes.filter((outcome: { taskId: string | null }) => outcome.taskId).every((outcome: { taskId: string; startAt: string; endAt: string }) =>
      (Date.parse(outcome.endAt) - Date.parse(outcome.startAt)) / 60_000 === tasks.find((task) => task.id === outcome.taskId)!.durationMinutes)).toBe(true);
    expect(outcomes.filter((outcome: { taskId: string | null }) => outcome.taskId).every((outcome: { startAt: string; endAt: string }) =>
      (Date.parse(outcome.startAt) >= Date.parse("2026-07-23T14:00:00Z") && Date.parse(outcome.endAt) <= Date.parse("2026-07-23T16:00:00Z"))
      || (Date.parse(outcome.startAt) >= Date.parse("2026-07-23T19:00:00Z") && Date.parse(outcome.endAt) <= Date.parse("2026-07-23T21:00:00Z")))).toBe(true);
    const selectedEmail = commitments.find((item) => item.id === "b2000000-0000-4000-8000-000000000015")!;
    expect(selectedEmail.provenance.source).toBe("gmail");
    expect(Date.parse(selectedEmail.deadlineAt!)).toBeGreaterThan(fixedNow);
    expect([selectedEmail.provenance.freshness.fetchedAt, selectedEmail.provenance.freshness.sourceUpdatedAt, selectedEmail.provenance.importedAt].every((timestamp) => !timestamp || Date.parse(timestamp) <= fixedNow)).toBe(true);
    expect(commitments.filter((item) => item.startAt?.startsWith("2026-07-23") && item.protected).map((item) => item.title)).toEqual(["Protected workout", "Protected partner time"]);
    const protectedOutcome = outcomes.find((outcome: { kind: string }) => outcome.kind === "protected-commitment")!;
    expect(protectedOutcome).toMatchObject({ commitmentId: "b2000000-0000-4000-8000-000000000018", startAt: "2026-07-23T21:30:00Z", endAt: "2026-07-23T22:30:00Z" });
    const protectedCommitment = commitments.find((item) => item.id === protectedOutcome.commitmentId)!;
    expect(protectedCommitment).toMatchObject({ protected: true, startAt: protectedOutcome.startAt, endAt: protectedOutcome.endAt });
    expect(protectedOutcome.rationale).toBe(`${protectedCommitment.title} remains unavailable.`);
    expect(commitments.some((item) => item.id === "b2000000-0000-4000-8000-000000000016" && item.endAt === commitments.find((other) => other.id === "b2000000-0000-4000-8000-000000000017")?.startAt)).toBe(true);
    const imported = outcomes.find((outcome: { kind: string }) => outcome.kind === "immutable-imported-task-placement")!;
    const importedTask = tasks.find((task) => task.id === imported.taskId)!;
    expect(importedTask).toMatchObject({ source: "github", immutable: true, deadlineAt: "2026-07-23T21:00:00Z" });
    expect(imported.endAt).toBe(importedTask.deadlineAt);
    expect(imported.expectedAction).toBe("local-proposal-only");
  });

  it("validates scheduling intent values, uniqueness, and task references", async () => {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const valid = { schemaVersion: 1, taskId: "a1000000-0000-4000-8000-000000000011", requiredCapacity: 55, goalAlignment: 60 };

    expect(schedulingIntentV1Schema.parse(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, requiredCapacity: -1 },
      { ...valid, requiredCapacity: 101 },
      { ...valid, requiredCapacity: 55.5 },
      { ...valid, goalAlignment: -1 },
      { ...valid, goalAlignment: 101 },
      { ...valid, goalAlignment: 60.5 },
      { ...valid, extra: true },
    ]) expect(() => schedulingIntentV1Schema.parse(invalid)).toThrow();
    expect(schedulingIntentV1Schema.parse({ ...valid, requiredCapacity: null, goalAlignment: null })).toMatchObject({ requiredCapacity: null, goalAlignment: null });
    expect(() => localStateV1Schema.parse({ ...state, schedulingIntents: [state.schedulingIntents[0], state.schedulingIntents[0]] })).toThrow();
    expect(() => localStateV1Schema.parse({ ...state, schedulingIntents: [{ ...valid, taskId: "a1000000-0000-4000-8000-000000000099" }] })).toThrow();
  });

  it("loads verified fixture bytes identically across fresh adapters and a simulated restart", async () => {
    const first = await new FixtureAdapter().loadFixtureDirectory(fixtureDirectory);
    const second = await new FixtureAdapter().loadFixtureDirectory(fixtureDirectory);
    const third = await new FixtureAdapter().loadFixtureDirectory(fixtureDirectory);
    const restarted = await new FixtureAdapter().loadFixtureDirectory(new URL(fixtureDirectory.href));

    expect(first.stateBytes).toBe(second.stateBytes);
    expect(second.stateBytes).toBe(third.stateBytes);
    expect(third.stateBytes).toBe(restarted.stateBytes);
    expect(first.recommendationsBytes).toBe(second.recommendationsBytes);
    expect(first.manifest.expected).toEqual({
      stateSha256: "5733f5d25e908121215647a33b4570d0f353eb77d17b4154c3c9befc43259b96",
      recommendationsSha256: "2b28b7f752cd540af983c7c858eaab2491d1382a2f77cb1b05832d467dc1b7c4",
    });
    expect(sha256(await readFile(manifestPath, "utf8"))).toBe("b22cedf7ae739feb1c868dbb8627992634f3cd2c6fe2b205dcd60409d5ec1c98");
    expect(sha256(first.stateBytes)).toBe(first.manifest.expected.stateSha256);
    expect(sha256(first.recommendationsBytes)).toBe(first.manifest.expected.recommendationsSha256);
  });

  it("rejects tampered, count-mismatched, missing, and extra fixture files", async () => {
    const copy = async () => {
      const directory = await mkdtemp(join(tmpdir(), "fixture-"));
      await cp(fixtureDirectory, directory, { recursive: true });
      return new URL(`file://${directory}/`);
    };
    const writeState = async (directory: URL, state: Record<string, unknown>) => {
      const bytes = `${JSON.stringify(state)}\n`;
      await writeFile(new URL("state.json", directory), bytes);
      const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
      manifest.files["state.json"].sha256 = sha256(bytes);
      manifest.expected.stateSha256 = sha256(bytes);
      await writeFile(new URL("manifest.json", directory), `${JSON.stringify(manifest)}\n`);
    };
    const adapter = new FixtureAdapter();
    const tampered = await copy();
    await writeFile(new URL("tasks.json", tampered), "[]\n");
    await expect(adapter.loadFixtureDirectory(tampered)).rejects.toThrow("hash mismatch");

    const countMismatch = await copy();
    const manifest = JSON.parse(await readFile(new URL("manifest.json", countMismatch), "utf8"));
    manifest.files["tasks.json"].count = 13;
    await writeFile(new URL("manifest.json", countMismatch), `${JSON.stringify(manifest)}\n`);
    await expect(adapter.loadFixtureDirectory(countMismatch)).rejects.toThrow("count mismatch");

    const missing = await copy();
    await rm(new URL("observations.json", missing));
    await expect(adapter.loadFixtureDirectory(missing)).rejects.toThrow("exactly match");

    const extra = await copy();
    await writeFile(new URL("extra.json", extra), "[]\n");
    await expect(adapter.loadFixtureDirectory(extra)).rejects.toThrow("exactly match");

    const stateMismatch = await copy();
    const mismatchedState = JSON.parse(await readFile(new URL("state.json", stateMismatch), "utf8"));
    mismatchedState.tasks.pop();
    mismatchedState.schedulingIntents.pop();
    await writeState(stateMismatch, mismatchedState);
    await expect(adapter.loadFixtureDirectory(stateMismatch)).rejects.toThrow("does not match normalized fixture records");

    const wrongIntent = await copy();
    const wrongIntentState = JSON.parse(await readFile(new URL("state.json", wrongIntent), "utf8"));
    wrongIntentState.schedulingIntents[0].requiredCapacity = 56;
    await writeState(wrongIntent, wrongIntentState);
    await expect(adapter.loadFixtureDirectory(wrongIntent)).rejects.toThrow("Golden scheduling intents are invalid");

    const duplicateIntent = await copy();
    const duplicateIntentState = JSON.parse(await readFile(new URL("state.json", duplicateIntent), "utf8"));
    duplicateIntentState.schedulingIntents.push(duplicateIntentState.schedulingIntents[0]);
    await writeState(duplicateIntent, duplicateIntentState);
    await expect(adapter.loadFixtureDirectory(duplicateIntent)).rejects.toThrow();

    const orphanIntent = await copy();
    const orphanIntentState = JSON.parse(await readFile(new URL("state.json", orphanIntent), "utf8"));
    orphanIntentState.schedulingIntents[0].taskId = "a1000000-0000-4000-8000-000000000099";
    await writeState(orphanIntent, orphanIntentState);
    await expect(adapter.loadFixtureDirectory(orphanIntent)).rejects.toThrow();

    const malformedIntent = await copy();
    const malformedIntentState = JSON.parse(await readFile(new URL("state.json", malformedIntent), "utf8"));
    malformedIntentState.schedulingIntents[0].goalAlignment = 101;
    await writeState(malformedIntent, malformedIntentState);
    await expect(adapter.loadFixtureDirectory(malformedIntent)).rejects.toThrow();

    const malformedRecommendations = await copy();
    const recommendations = JSON.parse(await readFile(new URL("recommendations.json", malformedRecommendations), "utf8"));
    recommendations.expectedOutcomes.pop();
    const recommendationBytes = `${JSON.stringify(recommendations)}\n`;
    await writeFile(new URL("recommendations.json", malformedRecommendations), recommendationBytes);
    const recommendationManifest = JSON.parse(await readFile(new URL("manifest.json", malformedRecommendations), "utf8"));
    recommendationManifest.files["recommendations.json"].sha256 = sha256(recommendationBytes);
    recommendationManifest.expected.recommendationsSha256 = sha256(recommendationBytes);
    await writeFile(new URL("manifest.json", malformedRecommendations), `${JSON.stringify(recommendationManifest)}\n`);
    await expect(adapter.loadFixtureDirectory(malformedRecommendations)).rejects.toThrow();

    await Promise.all([tampered, countMismatch, missing, extra, stateMismatch, wrongIntent, duplicateIntent, orphanIntent, malformedIntent, malformedRecommendations]
      .map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("rejects unknown keys, future versions, malformed instants, and invalid zones", () => {
    const valid = {
      schemaVersion: 1,
      id: "2d2882d0-6c16-4e0a-b5b6-4d2d6f604111",
      source: "fixture",
      sourceEntityId: "fixture-task-1",
      title: "Write brief",
      state: "open",
      durationMinutes: 30,
      deadlineAt: "2026-07-24T18:00:00Z",
      priority: 1,
      projectRef: null,
      labels: ["writing"],
      immutable: false,
      provenance: {
        schemaVersion: 1,
        source: "fixture",
        sourceEntityId: "fixture-task-1",
        consentRevision: 1,
        freshness: {
          schemaVersion: 1,
          fetchedAt: "2026-07-23T12:00:00Z",
          sourceUpdatedAt: null,
          expiresAt: null,
          state: "fixture",
        },
        importedAt: "2026-07-23T12:00:00Z",
      },
    };

    expect(() => normalizedTaskV1Schema.parse({ ...valid, schemaVersion: 2 })).toThrow();
    expect(() => normalizedTaskV1Schema.parse({ ...valid, extra: true })).toThrow();
    expect(() => normalizedTaskV1Schema.parse({ ...valid, deadlineAt: "tomorrow" })).toThrow();
    expect(() => localStateV1Schema.parse({
      schemaVersion: 1, revision: 0, profileId: valid.id, timeZone: "Mars/Olympus",
      connections: {}, tasks: [], commitments: [], observations: [], proposals: [], events: [], commandReceipts: {},
    })).toThrow();
    expect(() => normalizedTaskV1Schema.parse({ ...valid, labels: Array.from({ length: 101 }, () => "x") })).toThrow();
  });

  it("rejects oversized collections and invalid discriminated events", () => {
    expect(() => normalizedTaskV1Schema.parse({
      schemaVersion: 1, id: "2d2882d0-6c16-4e0a-b5b6-4d2d6f604111", source: "fixture",
      sourceEntityId: "fixture-task-1", title: "x".repeat(513), state: "open", durationMinutes: null,
      deadlineAt: null, priority: null, projectRef: null, labels: [], immutable: false,
      provenance: {
        schemaVersion: 1, source: "fixture", sourceEntityId: "fixture-task-1", consentRevision: 1,
        freshness: { schemaVersion: 1, fetchedAt: "2026-07-23T12:00:00Z", sourceUpdatedAt: null, expiresAt: null, state: "fixture" },
        importedAt: "2026-07-23T12:00:00Z",
      },
    })).toThrow();
    expect(() => domainEventV1Schema.parse({
      schemaVersion: 1, id: "2d2882d0-6c16-4e0a-b5b6-4d2d6f604112", sequence: 1,
      occurredAt: "2026-07-23T12:00:00Z", type: "NotAnEvent", commandId: "2d2882d0-6c16-4e0a-b5b6-4d2d6f604113", payload: {},
    })).toThrow();
  });

  it("keeps synthetic fixtures credential-free and network-free", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const runtime = loadRuntimeMode({});
    const adapter = new FixtureAdapter(runtime);

    expect(adapter.loadManifest(await readFile(manifestPath, "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(runtime).toBe("synthetic");
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("accepts only the reviewed public package baseline", async () => {
    expect(ReleaseBoundary.verifyPublic(JSON.parse(await readFile(packagePath, "utf8")))).toBe(true);
    expect(ReleaseBoundary.verifyPublic({ private: true, dependencies: { zod: "latest" } })).toBe(false);
  });
});
