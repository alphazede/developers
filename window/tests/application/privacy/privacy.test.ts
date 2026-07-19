import { describe, expect, it } from "vitest";

import {
  deleteProfile, deleteSource, exportPrivacy, forgetPattern, prunePrivacy, revokeSource,
  type PrivacyStateV1,
} from "../../../src/application/privacy";

const at = "2026-07-23T15:00:00Z";
const state = (): PrivacyStateV1 => ({
  schemaVersion: 1, revision: 4, profileId: "profile-private", timeZone: "America/Chicago", profileDeleted: false,
  connectors: [{ schemaVersion: 1, source: "github", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], consentRevision: 1, mode: "github-app", freshness: { schemaVersion: 1, fetchedAt: at, sourceUpdatedAt: null, expiresAt: null, state: "fresh" } }],
  tasks: [{ schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001", source: "github", sourceEntityId: "secret-provider-id", title: "Imported task", state: "open", durationMinutes: 30, deadlineAt: null, priority: 10, projectRef: null, labels: [], immutable: true, provenance: { schemaVersion: 1, source: "github", sourceEntityId: "secret-provider-id", consentRevision: 1, freshness: { schemaVersion: 1, fetchedAt: at, sourceUpdatedAt: null, expiresAt: null, state: "fresh" }, importedAt: at } }],
  schedulingIntents: [{ schemaVersion: 1, taskId: "10000000-0000-4000-8000-000000000001", requiredCapacity: 55, goalAlignment: 70 }],
  commitments: [], observations: [], proposals: [{ schemaVersion: 1, id: "20000000-0000-4000-8000-000000000001", taskId: "10000000-0000-4000-8000-000000000001", sourceRevision: 4, startAt: at, endAt: "2026-07-23T15:30:00Z", score: 80, breakdown: { capacityFit: 30, deadlineUrgency: 20, goalAlignment: 15, contextSwitch: 8, recoverySupport: 7 }, confidence: .8, limitations: [], status: "preview" }],
  evidence: [
    { id: "e-github", source: "github", patternRef: "pattern-secret-hmac", summary: "Capacity was a strong fit.", createdAt: "2026-07-01T15:00:00Z", pinned: false },
    { id: "e-local", source: "local", patternRef: null, summary: "Local self-report.", createdAt: "2026-07-22T15:00:00Z", pinned: false },
  ],
  patterns: [{ id: "pattern-secret-hmac", sources: ["github"], createdAt: "2026-07-01T15:00:00Z" }],
  effectAuthority: [{ id: "effect-secret", source: "github", createdAt: "2026-07-22T15:00:00Z" }],
  proposalReceipts: [
    { id: "receipt-secret", source: "github", taskId: "10000000-0000-4000-8000-000000000001", createdAt: "2026-07-22T15:00:00Z", summary: "Proposal previewed" },
    { id: "receipt-local", source: "local", taskId: null, createdAt: "2026-07-22T15:00:00Z", summary: "Local settings previewed" },
  ],
  focusSettings: { enabled: true, windows: [{ start: "09:00", end: "11:00" }, { start: "14:00", end: "16:00" }] },
  commandReceipts: {},
});
const command = (kind: string, expectedRevision = 4) => ({ schemaVersion: 1 as const, kind, commandId: `command-${kind}`, idempotencyKey: `key-${kind}`, expectedRevision, at });

describe("privacy application", () => {
  it("exports deterministic redacted data without handles or provider identifiers", () => {
    const exported = exportPrivacy(state());
    const bytes = JSON.stringify(exported);
    expect(exported).toEqual(exportPrivacy(state()));
    expect(bytes).toContain("Imported task");
    expect(bytes).toContain("Capacity was a strong fit");
    for (const secret of ["profile-private", "secret-provider-id", "pattern-secret-hmac", "effect-secret", "10000000-0000-4000-8000-000000000001", "token", "agentPrompt"]) expect(bytes).not.toContain(secret);
    expect(exported.connectors[0]).toMatchObject({ source: "github", freshness: "fresh", consentRevision: 1 });
    expect(exported.proposalReceipts).toContainEqual({ source: "github", createdAt: "2026-07-22T15:00:00Z", summary: "Proposal previewed" });
  });

  it("revokes and deletes one source plus its dependants while preserving local evidence", () => {
    const revoked = revokeSource(state(), { ...command("revoke-source"), kind: "revoke-source", source: "github" });
    expect(revoked.state.revision).toBe(5);
    expect(revoked.state.tasks).toHaveLength(0);
    expect(revoked.state.schedulingIntents).toHaveLength(0);
    expect(revoked.state.proposals).toHaveLength(0);
    expect(revoked.state.effectAuthority).toHaveLength(0);
    expect(revoked.state.evidence.map((item) => item.id)).toEqual(["e-local"]);
    expect(revoked.state.proposalReceipts.map((item) => item.id)).toEqual(["receipt-local"]);
    expect(revoked.receipt.removed.receipts).toBe(1);
    expect(revoked.receipt.remoteRevocation).toBe("not-attempted");
    expect(revoked.event).toMatchObject({ type: "PrivacyChanged", kind: "revoke-source", revision: 5 });

    const deleted = deleteSource(state(), { ...command("delete-source"), kind: "delete-source", source: "github" });
    expect(deleted.receipt.removed.tasks).toBe(1);
    expect(deleted.state.connectors).toHaveLength(0);
  });

  it("forgets a pattern without removing unrelated data", () => {
    const result = forgetPattern(state(), { ...command("forget-pattern"), kind: "forget-pattern", patternRef: "pattern-secret-hmac" });
    expect(result.state.patterns).toHaveLength(0);
    expect(result.state.evidence.map((item) => item.id)).toEqual(["e-local"]);
    expect(result.state.tasks).toHaveLength(1);
  });

  it("requires export/backup offer before profile deletion and removes all authority", () => {
    expect(() => deleteProfile(state(), { ...command("delete-profile"), kind: "delete-profile", exportOffered: false })).toThrow("EXPORT_REQUIRED");
    const result = deleteProfile(state(), { ...command("delete-profile"), kind: "delete-profile", exportOffered: true });
    expect(result.state.profileDeleted).toBe(true);
    expect(result.state.connectors).toEqual([]);
    expect(result.state.effectAuthority).toEqual([]);
    expect(result.state.tasks).toEqual([]);
  });

  it("is revision-safe, collision-safe, and idempotent", () => {
    const first = deleteSource(state(), { ...command("delete-source"), kind: "delete-source", source: "github" });
    const replay = deleteSource(first.state, { ...command("delete-source"), kind: "delete-source", source: "github" });
    expect(replay).toEqual(first);
    expect(() => deleteSource(state(), { ...command("delete-source", 3), kind: "delete-source", source: "github" })).toThrow("REVISION_CONFLICT");
    expect(() => deleteSource(first.state, { ...command("delete-source"), kind: "delete-source", source: "linear" })).toThrow("IDEMPOTENCY_COLLISION");
    expect(() => deleteSource(first.state, { ...command("delete-source"), kind: "delete-source", idempotencyKey: "new-key", source: "github" })).toThrow("IDEMPOTENCY_COLLISION");
    expect(() => deleteSource(state(), { ...command("delete-source"), kind: "delete-source", source: "github", remoteRevocation: "confirmed" } as never)).toThrow("INVALID_PRIVACY_COMMAND");
  });

  it("prunes fixed retention boundaries deterministically and preserves pinned evidence", () => {
    const input = state(); input.evidence.push({ id: "pinned", source: "local", patternRef: null, summary: "Pinned", createdAt: "2025-01-01T00:00:00Z", pinned: true });
    const result = prunePrivacy(input, { ...command("prune"), kind: "prune", at: "2026-10-30T15:00:00Z" });
    expect(result.state.tasks).toEqual([]);
    expect(result.state.schedulingIntents).toEqual([]);
    expect(result.state.proposals).toEqual([]);
    expect(result.state.evidence.map((item) => item.id)).toEqual(["pinned"]);
    expect(result.state.patterns).toEqual([]);
    expect(result.state.proposalReceipts).toEqual([]);
    expect(prunePrivacy(result.state, { ...command("prune"), kind: "prune", at: "2026-10-30T15:00:00Z" })).toEqual(result);
  });
});
