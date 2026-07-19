import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalStateV1 } from "../../../src/contracts/v1";
import { LocalStore } from "../../../src/storage/local-store/local-store";

const PROFILE_ID = "2d2882d0-6c16-4e0a-b5b6-4d2d6f604110";
const RESULT_ID = "2d2882d0-6c16-4e0a-b5b6-4d2d6f604111";
const MAX_BYTES = 10 * 1024 * 1024;
const directories: string[] = [];
const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "capacity-store-"));
  directories.push(directory);
  return directory;
};
const state = (revision = 0, commandReceipts: LocalStateV1["commandReceipts"] = {}): LocalStateV1 => ({
  schemaVersion: 1,
  revision,
  profileId: PROFILE_ID,
  timeZone: "America/Chicago",
  connections: {},
  tasks: [],
  commitments: [],
  observations: [],
  proposals: [],
  events: [],
  commandReceipts,
});
const receiptState = (commandId: string, revision = 1, receiptRevision = revision) => state(
  revision,
  Object.fromEntries([[commandId, { revision: receiptRevision, resultId: RESULT_ID }]]),
);
const commit = (store: LocalStore, commandId: string, nextState = receiptState(commandId), idempotencyKey = "key") =>
  store.commit({ expectedRevision: 0, commandId, idempotencyKey, nextState });
const exists = async (path: string) => access(path).then(() => true, () => false);
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalStore", () => {
  it("initializes only a pristine revision-zero store and never replaces an existing path", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const store = new LocalStore(file);

    await expect(store.initialize(state(1))).rejects.toThrow("STORE_WRITE_FAILED");
    await expect(store.initialize(state(0, { command: { revision: 1, resultId: RESULT_ID } }))).rejects.toThrow("STORE_WRITE_FAILED");
    expect(await exists(file)).toBe(false);

    await store.initialize(state());
    expect((await store.load()).revision).toBe(0);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect((await commit(store, "command")).ok).toBe(true);
    const committedBytes = await readFile(file);
    await chmod(directory, 0o755);
    await chmod(file, 0o644);
    await expect(store.initialize(state())).rejects.toThrow("STORE_ALREADY_EXISTS");
    expect(await readFile(file)).toEqual(committedBytes);
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(file)).mode & 0o777).toBe(0o644);

    expect((await store.load()).revision).toBe(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("fails closed without mutating corrupt, wrong-type, or symlink paths", async () => {
    const directory = await temporaryDirectory();
    const corruptFile = join(directory, "corrupt.json");
    await writeFile(corruptFile, "not-json", { mode: 0o644 });
    const corruptStore = new LocalStore(corruptFile);
    await expect(corruptStore.initialize(state())).rejects.toThrow("STORE_ALREADY_EXISTS");
    expect(await readFile(corruptFile, "utf8")).toBe("not-json");
    expect((await stat(corruptFile)).mode & 0o777).toBe(0o644);
    await expect(corruptStore.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    const directoryPath = join(directory, "directory.json");
    await mkdir(directoryPath);
    await expect(new LocalStore(directoryPath).initialize(state())).rejects.toThrow("STORE_ALREADY_EXISTS");
    await expect(new LocalStore(directoryPath).load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");
    expect((await lstat(directoryPath)).isDirectory()).toBe(true);

    const target = join(directory, "target.json");
    await writeFile(target, "target", { mode: 0o600 });
    const linkedFile = join(directory, "linked.json");
    await symlink(target, linkedFile);
    const linkedStore = new LocalStore(linkedFile);
    await expect(linkedStore.initialize(state())).rejects.toThrow("STORE_ALREADY_EXISTS");
    await expect(linkedStore.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");
    expect((await lstat(linkedFile)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("target");

    const realParent = join(directory, "real-parent");
    await mkdir(realParent, { mode: 0o700 });
    const realFile = join(realParent, "state.json");
    await new LocalStore(realFile).initialize(state());
    const linkedParent = join(directory, "linked-parent");
    await symlink(realParent, linkedParent);
    await expect(new LocalStore(join(linkedParent, "state.json")).load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    const ownerFile = join(directory, "owner.json");
    const ownerStore = new LocalStore(ownerFile);
    await ownerStore.initialize(state());
    await chmod(directory, 0o755);
    await chmod(ownerFile, 0o644);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("POSIX owner check unavailable");
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(ownerStore.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
      expect((await stat(ownerFile)).mode & 0o777).toBe(0o644);
    } finally {
      getuid.mockRestore();
    }
  });

  it("binds bounded command IDs to bounded idempotency keys and validates receipts", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const store = new LocalStore(file);
    await store.initialize(state());

    expect(await commit(store, "command")).toMatchObject({ ok: true, receipt: { revision: 1, resultId: RESULT_ID } });
    const committedBytes = await readFile(file);
    expect(await commit(store, "command")).toMatchObject({ ok: true, duplicate: true });
    expect(await commit(store, "command", receiptState("command"), "different")).toEqual({ ok: false, code: "IDEMPOTENCY_MISMATCH" });
    expect(await commit(store, "command", receiptState("command"), "")).toEqual({ ok: false, code: "INVALID_COMMAND" });
    expect(await readFile(file)).toEqual(committedBytes);
    expect(await store.commit({ expectedRevision: 1, commandId: "another", idempotencyKey: "key", nextState: state(2) })).toEqual({ ok: false, code: "INVALID_RECEIPT" });

    for (const [commandId, idempotencyKey] of [
      ["", "key"], [" ", "key"], ["x".repeat(129), "key"], ["new", ""], ["new", " "], ["new", "x".repeat(129)],
    ]) {
      expect(await store.commit({ expectedRevision: 1, commandId, idempotencyKey, nextState: state(2) })).toEqual({ ok: false, code: "INVALID_COMMAND" });
    }

    const prototypeFile = join(directory, "prototype.json");
    const prototypeStore = new LocalStore(prototypeFile);
    await prototypeStore.initialize(state());
    expect(await commit(prototypeStore, "__proto__")).toEqual({ ok: false, code: "INVALID_COMMAND" });
    expect((await prototypeStore.load()).revision).toBe(0);

    const receiptFile = join(directory, "receipt.json");
    const receiptStore = new LocalStore(receiptFile);
    await receiptStore.initialize(state());
    expect(await commit(receiptStore, "command", receiptState("command", 1, 999))).toEqual({ ok: false, code: "INVALID_RECEIPT" });
    const invalidResult = receiptState("command");
    invalidResult.commandReceipts.command.resultId = "not-a-uuid";
    expect((await commit(receiptStore, "command", invalidResult)).ok).toBe(false);
    expect((await receiptStore.load()).revision).toBe(0);
  });

  it("serializes competing commits and preserves prior receipts", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const store = new LocalStore(file);
    await store.initialize(state());
    const [first, second] = await Promise.all([commit(store, "first"), commit(store, "second")]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([{ ok: false, code: "STALE_REVISION" }]);
    const current = await store.load();
    expect(current.revision).toBe(1);
    expect(Object.keys(current.commandReceipts)).toHaveLength(1);

    const existingCommand = Object.keys(current.commandReceipts)[0];
    const next = state(2, Object.fromEntries([
      [existingCommand, current.commandReceipts[existingCommand]],
      ["next", { revision: 2, resultId: RESULT_ID }],
    ]));
    expect(await store.commit({ expectedRevision: 1, commandId: "next", idempotencyKey: "next-key", nextState: next })).toMatchObject({ ok: true });
    const dropped = receiptState("third", 3, 3);
    expect(await store.commit({ expectedRevision: 2, commandId: "third", idempotencyKey: "third-key", nextState: dropped })).toEqual({ ok: false, code: "INVALID_RECEIPT" });
  });

  it("rejects a schema-valid state above 10 MiB before replacing the authoritative file", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const store = new LocalStore(file);
    await store.initialize(state());
    const freshness = { schemaVersion: 1 as const, fetchedAt: "2026-07-23T15:00:00Z", sourceUpdatedAt: null, expiresAt: null, state: "fixture" as const };
    const tasks = Array.from({ length: 800 }, (_, index) => {
      const id = randomUUID();
      const sourceEntityId = `fixture-${index}`;
      return {
        schemaVersion: 1 as const, id, source: "fixture" as const, sourceEntityId, title: "t".repeat(512), state: "open",
        durationMinutes: 30, deadlineAt: null, priority: 1, projectRef: null, labels: Array.from({ length: 100 }, () => "l".repeat(128)),
        immutable: false, provenance: { schemaVersion: 1 as const, source: "fixture" as const, sourceEntityId, consentRevision: 1, freshness, importedAt: "2026-07-23T15:00:00Z" },
      };
    });
    const nextState: LocalStateV1 = { ...state(1, { command: { revision: 1, resultId: RESULT_ID } }), tasks };
    expect(Buffer.byteLength(JSON.stringify(nextState))).toBeGreaterThan(MAX_BYTES);
    expect(await commit(store, "command", nextState)).toEqual({ ok: false, code: "STORE_WRITE_FAILED" });
    expect((await stat(file)).size).toBeLessThan(MAX_BYTES);
    expect((await store.load()).revision).toBe(0);
    expect(await exists(`${file}.tmp`)).toBe(false);
  });

  it.each([
    ["before-write", 0],
    ["after-write", 0],
    ["after-file-fsync", 0],
    ["before-rename", 0],
    ["after-rename", 1],
  ] as const)("keeps an old-or-new revision after %s and cleans the temporary file", async (failAt, expectedRevision) => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const seed = new LocalStore(file);
    await seed.initialize(state());
    const failing = new LocalStore(file, { failAt });
    expect(await commit(failing, "command")).toEqual({ ok: false, code: "STORE_WRITE_FAILED" });

    const restarted = new LocalStore(file);
    expect((await restarted.load()).revision).toBe(expectedRevision);
    expect(await exists(`${file}.tmp`)).toBe(false);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    if (expectedRevision === 1) expect(await commit(restarted, "command")).toMatchObject({ ok: true, duplicate: true });
    else expect(await commit(restarted, "command")).toMatchObject({ ok: true });
  });

  it("strictly rejects malformed, future, checksum-invalid, oversized, and replaying corrupt state", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const store = new LocalStore(file);
    const reset = async () => {
      await rm(file, { force: true });
      await store.initialize(state());
      return JSON.parse(await readFile(file, "utf8"));
    };

    let envelope = await reset();
    envelope.unexpected = true;
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    envelope = await reset();
    envelope.schemaVersion = 2;
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    envelope = await reset();
    envelope.checksum = "0".repeat(64);
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    envelope = await reset();
    envelope.idempotencyKeys.ghost = "key";
    const registryData = { ...envelope };
    delete registryData.checksum;
    envelope.checksum = checksum(registryData);
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    envelope = await reset();
    envelope.payload.schemaVersion = 2;
    const data = { ...envelope };
    delete data.checksum;
    envelope.checksum = checksum(data);
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    await writeFile(file, "not-json");
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");
    await writeFile(file, "x".repeat(MAX_BYTES + 1));
    await expect(store.load()).rejects.toThrow("STORE_RECOVERY_REQUIRED");

    await rm(file, { force: true });
    await store.initialize(state());
    expect((await commit(store, "command")).ok).toBe(true);
    envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.checksum = "0".repeat(64);
    await writeFile(file, JSON.stringify(envelope));
    await expect(commit(store, "command")).rejects.toThrow("STORE_RECOVERY_REQUIRED");
  });

  it("creates a verified owner-only backup inside the serialized stream and deletes explicitly", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "state.json");
    const store = new LocalStore(file);
    await store.initialize(state());
    const backupDirectory = join(directory, "backup");
    await mkdir(backupDirectory, { mode: 0o755 });
    await chmod(backupDirectory, 0o755);
    const destination = join(backupDirectory, "state.json");

    const commitPromise = commit(store, "command");
    const backupPromise = store.backup(destination);
    expect((await commitPromise).ok).toBe(true);
    await backupPromise;
    expect((await new LocalStore(destination).load()).revision).toBe(1);
    expect(await readFile(destination)).toEqual(await readFile(file));
    expect((await stat(backupDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);

    await writeFile(`${file}.tmp`, "stale", { mode: 0o600 });
    await store.delete();
    expect(await exists(file)).toBe(false);
    expect(await exists(`${file}.tmp`)).toBe(false);
  });
});
