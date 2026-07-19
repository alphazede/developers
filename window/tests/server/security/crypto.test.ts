import { chmod, lstat, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DataKeyManager,
  MeetingPatternKey,
  SecurityError,
  decryptToken,
  deriveMeetingPatternKey,
  encryptToken,
  identifyDataKey,
  rotationFaultPoints,
} from "../../../src/server/security/crypto";

const createdAt = "2026-07-19T00:00:00Z";
const fixedKey = (byte: number) => identifyDataKey(Buffer.alloc(32, byte));
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const setupRotation = async () => {
  const directory = await mkdtemp(join(tmpdir(), "capacity-key-"));
  const keyPath = join(directory, "data-key.json"); const tokensPath = join(directory, "tokens.json");
  const manager = new DataKeyManager(keyPath); const key = await manager.load();
  const plaintext = ["refresh-secret", "access-secret"];
  const envelopes = plaintext.map((token) => encryptToken(token, { ...key, createdAt }));
  await writeFile(tokensPath, JSON.stringify(envelopes), { mode: 0o600 });
  return { directory, keyPath, tokensPath, manager, key, plaintext, envelopes };
};

describe("token crypto", () => {
  it("round trips strict authenticated envelopes with unique 12-byte nonces", () => {
    const key = fixedKey(7);
    const first = encryptToken("secret", { ...key, createdAt });
    const second = encryptToken("secret", { ...key, createdAt });
    expect(decryptToken(first, key.key)).toBe("secret");
    expect(first.nonce).not.toBe(second.nonce);
    expect(Buffer.from(first.nonce, "base64")).toHaveLength(12);
    expect(Buffer.from(first.authTag, "base64")).toHaveLength(16);
    expect(first).toMatchObject({ schemaVersion: 1, keyId: key.keyId, algorithm: "AES-256-GCM", createdAt });
  });

  it("rejects wrong keys and every authenticated or encoded field without leaking secrets", () => {
    const key = fixedKey(7); const envelope = encryptToken("secret-token", { ...key, createdAt });
    const alternate = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    const tampered = [
      { ...envelope, authTag: alternate(envelope.authTag) },
      { ...envelope, ciphertext: alternate(envelope.ciphertext) },
      { ...envelope, nonce: alternate(envelope.nonce) },
      { ...envelope, createdAt: "2026-07-20T00:00:00Z" },
      { ...envelope, schemaVersion: 2 as 1 },
      { ...envelope, keyId: "0".repeat(24) },
      { ...envelope, nonce: Buffer.alloc(8).toString("base64") },
      { ...envelope, nonce: `${envelope.nonce}!!!!` },
      { ...envelope, authTag: `${envelope.authTag}\n` },
      { ...envelope, extra: true } as typeof envelope,
    ];
    for (const value of tampered) expect(() => decryptToken(value, key.key)).toThrow("TOKEN_DECRYPT_FAILED");
    expect(() => decryptToken(envelope, fixedKey(8).key)).toThrow("TOKEN_DECRYPT_FAILED");
    expect(() => encryptToken("secret-token", { ...key, keyId: "0".repeat(24), createdAt })).toThrow("TOKEN_ENCRYPT_FAILED");
    try { decryptToken({ ...envelope, ciphertext: alternate(envelope.ciphertext) }, key.key); } catch (error) {
      expect(String(error)).not.toContain("secret-token");
    }
  });

  it("accepts only canonical 32-byte APP_DATA_KEY values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capacity-env-key-")); const path = join(directory, "unused.json");
    const value = Buffer.alloc(32, 9).toString("base64"); const key = await new DataKeyManager(path, value).load();
    expect(key.key.equals(Buffer.alloc(32, 9))).toBe(true);
    await expect(new DataKeyManager(path, `${value}!!!!`).load()).rejects.toThrow("DATA_KEY_INVALID");
    await expect(new DataKeyManager(path, ` ${value}\n`).load()).rejects.toThrow("DATA_KEY_INVALID");
    await expect(new DataKeyManager(path, Buffer.alloc(31).toString("base64")).load()).rejects.toThrow("DATA_KEY_INVALID");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new DataKeyManager(path, value).rotate([], join(directory, "tokens.json"))).rejects.toThrow("DATA_KEY_ROTATION_UNAVAILABLE");
    await rm(directory, { recursive: true, force: true });
  });

  it("creates and repairs owner-only key directories and files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capacity-file-key-")); const path = join(directory, "data-key.json");
    await chmod(directory, 0o755); const manager = new DataKeyManager(path); await manager.load();
    expect(await mode(directory)).toBe(0o700); expect(await mode(path)).toBe(0o600);
    await chmod(directory, 0o755); await chmod(path, 0o644); await new DataKeyManager(path).load();
    expect(await mode(directory)).toBe(0o700); expect(await mode(path)).toBe(0o600);
    await writeFile(path, "secret-corrupt-key", { mode: 0o600 });
    await expect(new DataKeyManager(path).load()).rejects.toMatchObject({
      code: "DATA_KEY_INVALID",
      invalidation: { reason: "data-key-lost", forget: ["meeting-patterns", "feedback", "dependent-proposals"] },
    });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, activeKeyId: "0".repeat(24), keys: [{ keyId: "0".repeat(24), key: "bad" }] }), { mode: 0o600 });
    await expect(new DataKeyManager(path).load()).rejects.toMatchObject({ invalidation: { reason: "data-key-lost" } });
    await rm(directory, { recursive: true, force: true });
  });

  it("fails closed with an explicit derived-data instruction after key loss", async () => {
    const fixture = await setupRotation();
    try {
      await unlink(fixture.keyPath); const restarted = new DataKeyManager(fixture.keyPath); await restarted.load();
      await expect(restarted.decrypt(fixture.envelopes[0]!)).rejects.toMatchObject({
        code: "DATA_KEY_UNAVAILABLE",
        invalidation: { reason: "data-key-lost", forget: ["meeting-patterns", "feedback", "dependent-proposals"] },
      });
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });

  it("derives a deterministic purpose-specific meeting-pattern key", () => {
    const key = fixedKey(7); const pattern = deriveMeetingPatternKey(key.key);
    expect(pattern).toBeInstanceOf(MeetingPatternKey); expect(Buffer.isBuffer(pattern)).toBe(false);
    expect(pattern.digest("series-a", ["participant-b", "participant-a"])).toBe("772224380e70acd1b174bf7fd20e630104cecc5c46f5a48fe6c1c8d24aef99c0");
    expect(pattern.digest("series-a", ["participant-a", "participant-b"])).toBe(pattern.digest("series-a", ["participant-b", "participant-a"]));
    expect(pattern.digest("series-b", ["participant-a", "participant-b"])).not.toBe(pattern.digest("series-a", ["participant-a", "participant-b"]));
    expect(deriveMeetingPatternKey(fixedKey(8).key).digest("series-a", ["participant-a", "participant-b"])).not.toBe(pattern.digest("series-a", ["participant-a", "participant-b"]));
    expect(() => encryptToken("secret", { key: pattern as unknown as Buffer, keyId: key.keyId, createdAt })).toThrow("TOKEN_ENCRYPT_FAILED");
  });

  it("verifies new envelopes before retiring the old key", async () => {
    const fixture = await setupRotation();
    try {
      const result = await fixture.manager.rotate(fixture.envelopes, fixture.tokensPath);
      expect(result.invalidation).toEqual({ reason: "data-key-rotated", forget: ["meeting-patterns", "feedback", "dependent-proposals"] });
      const restarted = new DataKeyManager(fixture.keyPath);
      await expect(Promise.all(result.envelopes.map((envelope) => restarted.decrypt(envelope)))).resolves.toEqual(fixture.plaintext);
      expect(() => decryptToken(result.envelopes[0]!, fixture.key.key)).toThrow("TOKEN_DECRYPT_FAILED");
      const ring = JSON.parse(await readFile(fixture.keyPath, "utf8"));
      expect(ring).toMatchObject({ schemaVersion: 1, activeKeyId: result.envelopes[0]!.keyId });
      expect(ring.keys).toHaveLength(1); expect(await mode(fixture.keyPath)).toBe(0o600); expect(await mode(fixture.tokensPath)).toBe(0o600);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });

  it.each(rotationFaultPoints)("keeps all envelopes readable after a crash at %s", async (point) => {
    const fixture = await setupRotation();
    try {
      const crashing = new DataKeyManager(fixture.keyPath, undefined, (current) => { if (current === point) throw new Error("injected"); });
      await expect(crashing.rotate(fixture.envelopes, fixture.tokensPath)).rejects.toThrow("DATA_KEY_ROTATION_FAILED");
      const persisted = JSON.parse(await readFile(fixture.tokensPath, "utf8")); const restarted = new DataKeyManager(fixture.keyPath);
      expect(new Set(persisted.map((envelope: { keyId: string }) => envelope.keyId)).size).toBeLessThanOrEqual(1);
      await expect(Promise.all(persisted.map((envelope: Parameters<DataKeyManager["decrypt"]>[0]) => restarted.decrypt(envelope)))).resolves.toEqual(fixture.plaintext);
      if (point === "after-verify") expect(JSON.parse(await readFile(fixture.keyPath, "utf8")).keys).toHaveLength(2);
      expect(await mode(fixture.keyPath)).toBe(0o600); expect(await mode(fixture.tokensPath)).toBe(0o600);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });

  it("uses stable typed secret-free errors", () => {
    const error = new SecurityError("DATA_KEY_ROTATION_FAILED");
    expect(error).toMatchObject({ name: "SecurityError", code: "DATA_KEY_ROTATION_FAILED", message: "DATA_KEY_ROTATION_FAILED" });
  });
});
