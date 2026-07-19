import {
  fixtureManifestV1Schema,
  localStateV1Schema,
  normalizedCommitmentV1Schema,
  normalizedTaskV1Schema,
  observationV1Schema,
  type FixtureManifestV1,
} from "../contracts/v1";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { RuntimeMode } from "./runtime-mode";
import { FixtureIntegrity } from "./fixture-integrity";

const outcomeKind = z.enum([
  "stronger-morning-deep-work",
  "lower-capacity-administration",
  "recovery-buffer",
  "protected-commitment",
  "immutable-imported-task-placement",
]);
const recommendationGoldenV1Schema = z.object({
  schemaVersion: z.literal(1),
  fixture: z.literal("jordan-lee"),
  goalAlignmentInputs: z.array(z.object({
    taskId: z.string().uuid(), goalRef: z.string().min(1), weight: z.number().finite(),
  }).strict()).min(1),
  expectedOutcomes: z.array(z.object({
    id: z.string().uuid(), kind: outcomeKind, taskId: z.string().uuid().nullable(),
    commitmentId: z.string().uuid().nullable(), startAt: z.string().datetime(), endAt: z.string().datetime(),
    expectedAction: z.enum(["propose", "reserve", "preserve", "local-proposal-only"]), rationale: z.string().min(1),
  }).strict()).length(5),
}).strict();

const fixtureSources = ["local", "fixture", "google-calendar", "gmail", "github", "linear", "microsoft", "strava", "oura", "ics"];

/** Validates supplied fixture bytes; it has no credential or network capability. */
export class FixtureAdapter {
  constructor(private readonly mode: RuntimeMode = "synthetic") {}

  loadManifest(input: string | unknown): FixtureManifestV1 {
    return fixtureManifestV1Schema.parse(this.parse(input));
  }

  loadTasks(input: string | unknown) { return z.array(normalizedTaskV1Schema).max(10_000).parse(this.parse(input)); }
  loadCommitments(input: string | unknown) { return z.array(normalizedCommitmentV1Schema).max(2_000).parse(this.parse(input)); }
  loadObservations(input: string | unknown) { return z.array(observationV1Schema).max(10_000).parse(this.parse(input)); }

  async loadFixtureDirectory(directory: URL) {
    if (this.mode !== "synthetic") throw new Error("FixtureAdapter is synthetic-only");
    const manifestBytes = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("manifest.json", directory)));
    const manifest = this.loadManifest(new TextDecoder().decode(manifestBytes));
    const files = await new FixtureIntegrity().verify(directory, manifest);
    const text = (name: string) => new TextDecoder().decode(files.get(name)!);
    const tasks = this.loadTasks(text("tasks.json"));
    const commitments = this.loadCommitments(text("commitments.json"));
    const observations = this.loadObservations(text("observations.json"));
    if (tasks.some((task) => task.source !== task.provenance.source
      || task.immutable !== ["github", "linear"].includes(task.source))) {
      throw new Error("Fixture task source semantics are invalid");
    }
    if (commitments.some((item) => item.participantSetKey !== null && !/^[a-f0-9]{64}$/.test(item.participantSetKey)
      || item.provenance.source === "gmail" && item.kind !== "selected-email-commitment"
      || item.provenance.source !== "gmail" && (!["google-calendar", "microsoft", "ics", "fixture", "local"].includes(item.provenance.source)
        || !["calendar-event", "protected-time"].includes(item.kind)))) {
      throw new Error("Fixture commitment source semantics are invalid");
    }
    if (commitments.some((item) => [item.provenance.freshness.fetchedAt, item.provenance.freshness.sourceUpdatedAt, item.provenance.importedAt]
      .some((timestamp) => timestamp !== null && Temporal.Instant.compare(Temporal.Instant.from(timestamp), Temporal.Instant.from(manifest.fixedNow)) > 0))) {
      throw new Error("Fixture commitment provenance cannot be after fixed-now");
    }
    const recurring = commitments.filter((item) => item.recurringSeriesRef === "series-demanding-sync");
    if (recurring.length !== 3 || new Set(recurring.map((item) => item.participantSetKey)).size !== 1) {
      throw new Error("Fixture recurring meeting grouping is invalid");
    }
    if (observations.some((item) => !["strava", "oura", "github", "linear", "google-calendar", "microsoft", "local", "fixture"].includes(item.provenance.source)
      || item.provenance.source === "strava" && item.signal !== "activity"
      || item.provenance.source === "oura" && item.signal !== "readiness"
      || ["github", "linear"].includes(item.provenance.source) && item.signal !== "task-outcome"
      || ["google-calendar", "microsoft"].includes(item.provenance.source) && item.signal !== "meeting-after"
      || ["local", "fixture"].includes(item.provenance.source) && item.signal !== "self-report")) {
      throw new Error("Fixture observation source semantics are invalid");
    }
    const state = localStateV1Schema.parse(this.parse(text("state.json")));
    const recommendations = recommendationGoldenV1Schema.parse(this.parse(text("recommendations.json")));
    if (JSON.stringify([state.tasks, state.commitments, state.observations]) !== JSON.stringify([tasks, commitments, observations])) {
      throw new Error("Golden state does not match normalized fixture records");
    }
    if (Object.keys(state.connections).sort().join() !== [...fixtureSources].sort().join()
      || Object.values(state.connections).some((connection) => connection.consentRevision < 1 || connection.capabilities.length === 0 || connection.freshness.state !== "fixture")) {
      throw new Error("Golden state connections are incomplete");
    }
    if (manifest.files["state.json"].sha256 !== manifest.expected.stateSha256
      || manifest.files["recommendations.json"].sha256 !== manifest.expected.recommendationsSha256) {
      throw new Error("Golden hashes do not match manifest expectations");
    }
    const expectedKinds = outcomeKind.options;
    const fixedNow = Temporal.Instant.from(manifest.fixedNow);
    const gateContains = (outcome: { startAt: string; endAt: string }) => manifest.focusGate.windows.some((window) => {
      const date = Temporal.PlainDate.from(manifest.canonicalDay);
      const start = date.toZonedDateTime({ timeZone: manifest.persona.timeZone, plainTime: Temporal.PlainTime.from(window.startLocalTime) }).toInstant();
      const end = date.toZonedDateTime({ timeZone: manifest.persona.timeZone, plainTime: Temporal.PlainTime.from(window.endLocalTime) }).toInstant();
      return Temporal.Instant.compare(Temporal.Instant.from(outcome.startAt), start) >= 0
        && Temporal.Instant.compare(Temporal.Instant.from(outcome.endAt), end) <= 0;
    });
    const canonical = commitments.filter((item) => item.startAt?.startsWith(manifest.canonicalDay) || item.deadlineAt?.startsWith(manifest.canonicalDay));
    const selectedEmail = canonical.find((item) => item.kind === "selected-email-commitment" && item.deadlineAt && Temporal.Instant.compare(Temporal.Instant.from(item.deadlineAt), fixedNow) > 0);
    const canonicalProtectedTitles = canonical.filter((item) => item.protected).map((item) => item.title);
    const adjacentLoad = canonical.filter((item) => item.kind === "calendar-event" && item.startAt && item.endAt)
      .some((first, index, items) => items.some((second, secondIndex) => index !== secondIndex && first.endAt === second.startAt
        && [first, second].some((item) => item.title === "Private demanding meeting" && item.participantSetKey === "0eb768080a293a429e1d1b382a6a6aa6cb76123ca5e38e98ccb9b3ca8792234a")));
    if (recommendations.expectedOutcomes.some((outcome, index) => outcome.kind !== expectedKinds[index])
      || recommendations.expectedOutcomes.some((outcome) => Temporal.Instant.compare(Temporal.Instant.from(outcome.startAt), fixedNow) < 0 || Temporal.Instant.compare(Temporal.Instant.from(outcome.startAt), Temporal.Instant.from(outcome.endAt)) >= 0)
      || recommendations.goalAlignmentInputs.some((input) => !tasks.some((task) => task.id === input.taskId))
      || recommendations.expectedOutcomes.some((outcome) => outcome.taskId !== null && !tasks.some((task) => task.id === outcome.taskId))
      || recommendations.expectedOutcomes.some((outcome) => outcome.taskId !== null && !gateContains(outcome)
        || outcome.taskId !== null && Temporal.Instant.from(outcome.startAt).until(Temporal.Instant.from(outcome.endAt)).total({ unit: "minutes" }) !== tasks.find((task) => task.id === outcome.taskId)!.durationMinutes)
      || !selectedEmail || !adjacentLoad || !["Protected workout", "Protected partner time"].every((title) => canonicalProtectedTitles.includes(title))
      || recommendations.expectedOutcomes.some((outcome) => outcome.kind === "protected-commitment" && !commitments.some((item) => item.id === outcome.commitmentId && item.protected && item.startAt === outcome.startAt && item.endAt === outcome.endAt
        && outcome.rationale === `${item.title} remains unavailable.`)
        || outcome.kind === "lower-capacity-administration" && outcome.commitmentId !== selectedEmail?.id)) {
      throw new Error("Recommendation golden references invalid fixture inputs");
    }
    const importedPlacement = recommendations.expectedOutcomes.find((outcome) => outcome.kind === "immutable-imported-task-placement")!;
    if (importedPlacement.expectedAction !== "local-proposal-only"
      || !tasks.some((task) => task.id === importedPlacement.taskId && task.immutable && ["github", "linear"].includes(task.source))) {
      throw new Error("Imported task placement must remain local-only");
    }
    return { manifest, stateBytes: text("state.json"), recommendationsBytes: text("recommendations.json") };
  }

  private parse(input: string | unknown): unknown {
    if (this.mode !== "synthetic") throw new Error("FixtureAdapter is synthetic-only");
    return typeof input === "string" ? JSON.parse(input) : input;
  }
}
