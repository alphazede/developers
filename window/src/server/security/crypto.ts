import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenEnvelopeV1 } from "../../contracts/v1";

export type DataKey = { keyId: string; key: Buffer };
export type DerivedDataInvalidation = Readonly<{
  reason: "data-key-rotated" | "data-key-lost";
  forget: readonly ["meeting-patterns", "feedback", "dependent-proposals"];
}>;
export type SecurityErrorCode = "DATA_KEY_INVALID" | "DATA_KEY_UNAVAILABLE" | "DATA_KEY_ROTATION_UNAVAILABLE" | "DATA_KEY_ROTATION_FAILED" | "TOKEN_ENCRYPT_FAILED" | "TOKEN_DECRYPT_FAILED";

export class SecurityError extends Error {
  constructor(readonly code: SecurityErrorCode, readonly invalidation?: DerivedDataInvalidation) { super(code); this.name = "SecurityError"; }
}

const invalidation = (reason: DerivedDataInvalidation["reason"]): DerivedDataInvalidation => ({
  reason,
  forget: ["meeting-patterns", "feedback", "dependent-proposals"],
});
const fail = (code: SecurityErrorCode, instruction?: DerivedDataInvalidation): never => { throw new SecurityError(code, instruction); };
const KEY_ID = /^[a-f0-9]{24}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const decodeBase64 = (value: unknown, expectedBytes: number | undefined, code: SecurityErrorCode) => {
  if (typeof value !== "string" || !BASE64.test(value)) return fail(code);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || expectedBytes !== undefined && decoded.length !== expectedBytes) return fail(code);
  return decoded;
};
const dataKeyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 24);
export const identifyDataKey = (key: Buffer): DataKey => {
  if (!Buffer.isBuffer(key) || key.length !== 32) return fail("DATA_KEY_INVALID");
  return { key, keyId: dataKeyId(key) };
};
const decodeKey = (value: string) => {
  try { return identifyDataKey(decodeBase64(value, 32, "DATA_KEY_INVALID")); }
  catch { return fail("DATA_KEY_INVALID", invalidation("data-key-lost")); }
};

type StoredKey = { keyId: string; key: string };
type KeyRing = { schemaVersion: 1; activeKeyId: string; keys: StoredKey[] };
const stored = (value: DataKey): StoredKey => ({ keyId: value.keyId, key: value.key.toString("base64") });
const serializedRing = (active: string, keys: DataKey[]): KeyRing => ({ schemaVersion: 1, activeKeyId: active, keys: keys.map(stored) });
const parseRing = (input: string): { activeKeyId: string; keys: DataKey[] } => {
  try {
    const value: unknown = JSON.parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join() !== "activeKeyId,keys,schemaVersion") return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
    const ring = value as Partial<KeyRing>;
    if (ring.schemaVersion !== 1 || typeof ring.activeKeyId !== "string" || !KEY_ID.test(ring.activeKeyId)
      || !Array.isArray(ring.keys) || ring.keys.length < 1 || ring.keys.length > 2) return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
    const keys = ring.keys.map((entry) => {
      if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join() !== "key,keyId"
        || typeof entry.keyId !== "string" || typeof entry.key !== "string") return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
      const key = decodeKey(entry.key);
      if (entry.keyId !== key.keyId) return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
      return key;
    });
    if (new Set(keys.map((key) => key.keyId)).size !== keys.length || !keys.some((key) => key.keyId === ring.activeKeyId)) return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
    return { activeKeyId: ring.activeKeyId, keys };
  } catch (error) {
    if (error instanceof SecurityError) return fail(error.code, error.invalidation ?? invalidation("data-key-lost"));
    return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
  }
};

const ownerUid = () => typeof process.getuid === "function" ? process.getuid() : undefined;
const ensurePrivateDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || ownerUid() !== undefined && details.uid !== ownerUid()) return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
  await chmod(path, 0o700);
};
const ensurePrivateFile = async (path: string) => {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || ownerUid() !== undefined && details.uid !== ownerUid()) return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
  await chmod(path, 0o600);
};
const fsyncDirectory = async (path: string) => { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } };

const atomicStages = ["pending", "tokens", "retire"] as const;
const atomicPoints = ["before-write", "after-write", "after-file-sync", "before-rename", "after-rename", "after-directory-sync"] as const;
export const rotationFaultPoints = [
  ...atomicStages.flatMap((stage) => atomicPoints.map((point) => `${stage}:${point}` as const)),
  "before-verify",
  "after-verify",
] as const;
export type RotationFaultPoint = typeof rotationFaultPoints[number];
type RotationFaultHook = (point: RotationFaultPoint) => void | Promise<void>;

const atomicWrite = async (path: string, contents: string, stage: typeof atomicStages[number], hook?: RotationFaultHook) => {
  const directory = dirname(path); const temporary = `${path}.${stage}.tmp`;
  await ensurePrivateDirectory(directory); await unlink(temporary).catch(() => undefined); await hook?.(`${stage}:before-write`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents, "utf8"); await hook?.(`${stage}:after-write`); await handle.sync(); await hook?.(`${stage}:after-file-sync`); }
    finally { await handle.close(); }
    await hook?.(`${stage}:before-rename`); await rename(temporary, path); await chmod(path, 0o600); await hook?.(`${stage}:after-rename`);
    await fsyncDirectory(directory); await hook?.(`${stage}:after-directory-sync`);
  } finally { await unlink(temporary).catch(() => undefined); }
};

export class DataKeyManager {
  constructor(private readonly path: string, private readonly environment = process.env.APP_DATA_KEY, private readonly fault?: RotationFaultHook) {}

  private async fileRingUnchecked() {
    await ensurePrivateDirectory(dirname(this.path));
    try { await ensurePrivateFile(this.path); return parseRing(await readFile(this.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SecurityError) throw error;
        return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
      }
    }
    const key = identifyDataKey(randomBytes(32)); const ring = serializedRing(key.keyId, [key]);
    try {
      const handle = await open(this.path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(ring), "utf8"); await handle.sync(); } finally { await handle.close(); }
      await chmod(this.path, 0o600); await fsyncDirectory(dirname(this.path));
      return { activeKeyId: key.keyId, keys: [key] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") { await ensurePrivateFile(this.path); return parseRing(await readFile(this.path, "utf8")); }
      return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
    }
  }

  private async fileRing() {
    try { return await this.fileRingUnchecked(); }
    catch (error) {
      if (error instanceof SecurityError) throw error;
      return fail("DATA_KEY_INVALID", invalidation("data-key-lost"));
    }
  }

  private async ring() {
    if (this.environment !== undefined) { const key = decodeKey(this.environment); return { activeKeyId: key.keyId, keys: [key] }; }
    return this.fileRing();
  }

  async load(): Promise<DataKey> {
    const ring = await this.ring();
    return ring.keys.find((key) => key.keyId === ring.activeKeyId)!;
  }

  async decrypt(envelope: TokenEnvelopeV1) {
    validateEnvelope(envelope);
    const ring = await this.ring(); const key = ring.keys.find((candidate) => candidate.keyId === envelope.keyId);
    if (!key) return fail("DATA_KEY_UNAVAILABLE", invalidation("data-key-lost"));
    return decryptToken(envelope, key.key);
  }

  async rotate(envelopes: TokenEnvelopeV1[], tokensPath: string): Promise<{ envelopes: TokenEnvelopeV1[]; invalidation: DerivedDataInvalidation }> {
    if (this.environment !== undefined) return fail("DATA_KEY_ROTATION_UNAVAILABLE");
    try {
      const ring = await this.fileRing();
      const envelopeKeyIds = new Set(envelopes.map((envelope) => envelope.keyId));
      if (envelopeKeyIds.size > 1) return fail("DATA_KEY_ROTATION_FAILED");
      const currentKeyId = envelopes[0]?.keyId ?? ring.activeKeyId;
      const current = ring.keys.find((key) => key.keyId === currentKeyId);
      if (!current) return fail("DATA_KEY_UNAVAILABLE", invalidation("data-key-lost"));
      const plaintext = envelopes.map((envelope) => decryptToken(envelope, current.key));
      const next = identifyDataKey(randomBytes(32));
      const rotated = plaintext.map((token, index) => encryptToken(token, { ...next, createdAt: envelopes[index]!.createdAt }));
      await atomicWrite(this.path, JSON.stringify(serializedRing(current.keyId, [current, next])), "pending", this.fault);
      await atomicWrite(tokensPath, JSON.stringify(rotated), "tokens", this.fault);
      await this.fault?.("before-verify");
      const persistedRing = await this.fileRing();
      const persisted = JSON.parse(await readFile(tokensPath, "utf8")) as unknown;
      if (!Array.isArray(persisted) || persisted.length !== plaintext.length) return fail("DATA_KEY_ROTATION_FAILED");
      persisted.forEach((envelope, index) => {
        const typed = envelope as TokenEnvelopeV1; const key = persistedRing.keys.find((candidate) => candidate.keyId === typed.keyId);
        if (!key || decryptToken(typed, key.key) !== plaintext[index]) return fail("DATA_KEY_ROTATION_FAILED");
      });
      await this.fault?.("after-verify");
      await atomicWrite(this.path, JSON.stringify(serializedRing(next.keyId, [next])), "retire", this.fault);
      return { envelopes: rotated, invalidation: invalidation("data-key-rotated") };
    } catch (error) {
      if (error instanceof SecurityError && error.invalidation?.reason === "data-key-lost") throw error;
      return fail("DATA_KEY_ROTATION_FAILED");
    }
  }
}

const metadata = (envelope: Pick<TokenEnvelopeV1, "schemaVersion" | "keyId" | "algorithm" | "createdAt">) => Buffer.from(JSON.stringify({ schemaVersion: envelope.schemaVersion, keyId: envelope.keyId, algorithm: envelope.algorithm, createdAt: envelope.createdAt }));
const validInstant = (value: unknown) => typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
const validateEnvelope = (envelope: TokenEnvelopeV1) => {
  if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join() !== "algorithm,authTag,ciphertext,createdAt,keyId,nonce,schemaVersion"
    || envelope.schemaVersion !== 1 || envelope.algorithm !== "AES-256-GCM"
    || typeof envelope.keyId !== "string" || !KEY_ID.test(envelope.keyId) || !validInstant(envelope.createdAt)) return fail("TOKEN_DECRYPT_FAILED");
  decodeBase64(envelope.nonce, 12, "TOKEN_DECRYPT_FAILED"); decodeBase64(envelope.authTag, 16, "TOKEN_DECRYPT_FAILED"); decodeBase64(envelope.ciphertext, undefined, "TOKEN_DECRYPT_FAILED");
};

export const encryptToken = (token: string, input: DataKey & { createdAt: string }): TokenEnvelopeV1 => {
  try {
    const key = identifyDataKey(input.key);
    if (typeof token !== "string" || input.keyId !== key.keyId || !validInstant(input.createdAt)) return fail("TOKEN_ENCRYPT_FAILED");
    const nonce = randomBytes(12); const header = { schemaVersion: 1 as const, keyId: key.keyId, algorithm: "AES-256-GCM" as const, createdAt: input.createdAt };
    const cipher = createCipheriv("aes-256-gcm", key.key, nonce); cipher.setAAD(metadata(header)); const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { ...header, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  } catch { return fail("TOKEN_ENCRYPT_FAILED"); }
};

export const decryptToken = (envelope: TokenEnvelopeV1, keyBytes: Buffer) => {
  try {
    const key = identifyDataKey(keyBytes); validateEnvelope(envelope); if (envelope.keyId !== key.keyId) return fail("TOKEN_DECRYPT_FAILED");
    const decipher = createDecipheriv("aes-256-gcm", key.key, decodeBase64(envelope.nonce, 12, "TOKEN_DECRYPT_FAILED")); decipher.setAAD(metadata(envelope));
    decipher.setAuthTag(decodeBase64(envelope.authTag, 16, "TOKEN_DECRYPT_FAILED"));
    return Buffer.concat([decipher.update(decodeBase64(envelope.ciphertext, undefined, "TOKEN_DECRYPT_FAILED")), decipher.final()]).toString("utf8");
  } catch { return fail("TOKEN_DECRYPT_FAILED"); }
};

export class MeetingPatternKey {
  private constructor(private readonly key: Buffer) {}
  static derive(dataKey: Buffer) {
    identifyDataKey(dataKey);
    return new MeetingPatternKey(Buffer.from(hkdfSync("sha256", dataKey, Buffer.alloc(0), "meeting-pattern:v1", 32)));
  }
  digest(seriesRef: string, providerParticipantIds: readonly string[]) {
    if (!seriesRef || providerParticipantIds.some((id) => !id)) return fail("DATA_KEY_INVALID");
    return createHmac("sha256", this.key).update(`meeting-pattern:v1|${seriesRef}|${[...providerParticipantIds].sort().join("|")}`).digest("hex");
  }
}
export const deriveMeetingPatternKey = (key: Buffer) => MeetingPatternKey.derive(key);
