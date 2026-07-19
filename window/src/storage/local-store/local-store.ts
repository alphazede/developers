import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { localStateV1Schema, type LocalStateV1 } from "../../contracts/v1";

const MAX_BYTES = 10 * 1024 * 1024;
const boundedValue = z.string().min(1).max(128).refine((value) => value.trim() === value);
const commandIdSchema = boundedValue
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const registrySchema = z.record(commandIdSchema, boundedValue).superRefine((registry, context) => {
  if (Object.keys(registry).length > 10_000) context.addIssue({ code: "custom", message: "Too many idempotency records" });
});
const envelopeDataSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  payload: localStateV1Schema,
  idempotencyKeys: registrySchema,
}).strict();
const envelopeSchema = envelopeDataSchema.extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type EnvelopeData = z.infer<typeof envelopeDataSchema>;
type Envelope = z.infer<typeof envelopeSchema>;
type FaultAt = "before-write" | "after-write" | "after-file-fsync" | "before-rename" | "after-rename";
export type CommitResult =
  | { ok: true; receipt: { revision: number; resultId: string }; duplicate?: true }
  | { ok: false; code: "INVALID_COMMAND" | "IDEMPOTENCY_MISMATCH" | "INVALID_RECEIPT" | "STALE_REVISION" | "STORE_WRITE_FAILED" };
export type CommitInput = { expectedRevision: number; commandId: string; idempotencyKey: string; nextState: LocalStateV1 };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const ownerUid = () => typeof process.getuid === "function" ? process.getuid() : undefined;
const sameReceipt = (left: { revision: number; resultId: string }, right: { revision: number; resultId: string }) =>
  left.revision === right.revision && left.resultId === right.resultId;

export class LocalStore {
  private chain = Promise.resolve();

  constructor(private readonly path: string, private readonly faults: { failAt?: FaultAt } = {}) {}

  private async serialized<T>(work: () => Promise<T>) {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async sync(path: string) {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async prepareDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || ownerUid() !== undefined && details.uid !== ownerUid()) {
      throw new Error("STORE_RECOVERY_REQUIRED");
    }
    await chmod(directory, 0o700);
  }

  private async prepareForRead() {
    const directory = dirname(this.path);
    const directoryDetails = await lstat(directory);
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()
      || ownerUid() !== undefined && directoryDetails.uid !== ownerUid()) throw new Error("STORE_RECOVERY_REQUIRED");
    const fileDetails = await lstat(this.path);
    if (!fileDetails.isFile() || fileDetails.isSymbolicLink()
      || ownerUid() !== undefined && fileDetails.uid !== ownerUid()) throw new Error("STORE_RECOVERY_REQUIRED");
    await chmod(directory, 0o700);
    await chmod(this.path, 0o600);
  }

  private seal(data: EnvelopeData): Envelope {
    const parsed = envelopeDataSchema.parse(data);
    return { ...parsed, checksum: digest(parsed) };
  }

  private validate(envelope: Envelope) {
    const { checksum, ...data } = envelope;
    if (digest(data) !== checksum || data.revision !== data.payload.revision) throw new Error("STORE_RECOVERY_REQUIRED");
    const receiptKeys = Object.keys(data.payload.commandReceipts).sort();
    const idempotencyKeys = Object.keys(data.idempotencyKeys).sort();
    if (receiptKeys.length !== idempotencyKeys.length || receiptKeys.some((key, index) => key !== idempotencyKeys[index])
      || Object.values(data.payload.commandReceipts).some((receipt) => receipt.revision < 1 || receipt.revision > data.revision)) {
      throw new Error("STORE_RECOVERY_REQUIRED");
    }
    return envelope;
  }

  private async writeAtomic(envelope: Envelope, createOnly = false) {
    const bytes = Buffer.from(JSON.stringify(envelope));
    if (bytes.byteLength > MAX_BYTES) throw new Error("STORE_WRITE_FAILED");
    const directory = dirname(this.path);
    const temporary = `${this.path}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    await this.prepareDirectory(directory);
    try {
      if (this.faults.failAt === "before-write") throw new Error();
      await unlink(temporary).catch(() => undefined);
      handle = await open(temporary, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      if (this.faults.failAt === "after-write") throw new Error();
      await handle.sync();
      if (this.faults.failAt === "after-file-fsync" || this.faults.failAt === "before-rename") throw new Error();
      await handle.close();
      handle = undefined;
      if (createOnly) {
        await link(temporary, this.path);
        await unlink(temporary);
      } else await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      if (this.faults.failAt === "after-rename") throw new Error();
      await this.sync(directory);
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw new Error("STORE_WRITE_FAILED");
    }
  }

  private async readEnvelope() {
    try {
      await this.prepareForRead();
      const bytes = await readFile(this.path);
      if (bytes.byteLength > MAX_BYTES) throw new Error();
      return this.validate(envelopeSchema.parse(JSON.parse(bytes.toString("utf8"))));
    } catch {
      throw new Error("STORE_RECOVERY_REQUIRED");
    }
  }

  async initialize(state: LocalStateV1) {
    return this.serialized(async () => {
      const payload = localStateV1Schema.parse(state);
      if (payload.revision !== 0 || Object.keys(payload.commandReceipts).length) throw new Error("STORE_WRITE_FAILED");
      try {
        await lstat(this.path);
        throw new Error("STORE_ALREADY_EXISTS");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.writeAtomic(this.seal({ schemaVersion: 1, revision: 0, payload, idempotencyKeys: {} }), true);
    });
  }

  async load(): Promise<LocalStateV1> {
    return this.serialized(async () => (await this.readEnvelope()).payload);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return this.serialized(async () => {
      if (!commandIdSchema.safeParse(input.commandId).success || !boundedValue.safeParse(input.idempotencyKey).success) {
        return { ok: false, code: "INVALID_COMMAND" };
      }
      const current = await this.readEnvelope();
      if (own(current.payload.commandReceipts, input.commandId)) {
        if (current.idempotencyKeys[input.commandId] !== input.idempotencyKey) return { ok: false, code: "IDEMPOTENCY_MISMATCH" };
        return { ok: true, receipt: current.payload.commandReceipts[input.commandId], duplicate: true };
      }
      if (input.expectedRevision !== current.revision || input.nextState.revision !== current.revision + 1) {
        return { ok: false, code: "STALE_REVISION" };
      }
      const parsed = localStateV1Schema.safeParse(input.nextState);
      if (!parsed.success) return { ok: false, code: "STORE_WRITE_FAILED" };
      const nextState = parsed.data;
      const nextReceipt = own(nextState.commandReceipts, input.commandId) ? nextState.commandReceipts[input.commandId] : undefined;
      const priorReceipts = Object.entries(current.payload.commandReceipts);
      if (!nextReceipt || nextReceipt.revision !== nextState.revision
        || Object.keys(nextState.commandReceipts).length !== priorReceipts.length + 1
        || priorReceipts.some(([key, receipt]) => !own(nextState.commandReceipts, key) || !sameReceipt(receipt, nextState.commandReceipts[key]))) {
        return { ok: false, code: "INVALID_RECEIPT" };
      }
      try {
        const idempotencyKeys = { ...current.idempotencyKeys, [input.commandId]: input.idempotencyKey };
        const envelope = this.validate(this.seal({ schemaVersion: 1, revision: nextState.revision, payload: nextState, idempotencyKeys }));
        await this.writeAtomic(envelope);
        return { ok: true, receipt: nextReceipt };
      } catch {
        return { ok: false, code: "STORE_WRITE_FAILED" };
      }
    });
  }

  async backup(destination: string) {
    return this.serialized(async () => {
      const envelope = await this.readEnvelope();
      const bytes = Buffer.from(JSON.stringify(envelope));
      const directory = dirname(destination);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(destination, bytes, { mode: 0o600 });
      await chmod(destination, 0o600);
      await this.sync(destination);
      await this.sync(directory);
      const copied = await readFile(destination);
      if (!copied.equals(bytes)) throw new Error("STORE_RECOVERY_REQUIRED");
      await new LocalStore(destination).readEnvelope();
    });
  }

  async delete() {
    return this.serialized(async () => {
      await rm(`${this.path}.tmp`, { force: true });
      await rm(this.path, { force: true });
      await this.sync(dirname(this.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }
}
