import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { isEffectState, type EffectState } from "../../application/effects";
import { localStateV1Schema, tokenEnvelopeV1Schema, type FreshnessV1, type LocalStateV1, type NormalizedCommitmentV1, type NormalizedTaskV1, type TokenEnvelopeV1 } from "../../contracts/v1";

const MAX_BYTES = 10 * 1024 * 1024;
const boundedValue = z.string().min(1).max(128).refine((value) => value.trim() === value);
const commandIdSchema = boundedValue
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const registrySchema = z.record(commandIdSchema, boundedValue).superRefine((registry, context) => {
  if (Object.keys(registry).length > 10_000) context.addIssue({ code: "custom", message: "Too many idempotency records" });
});
const connectorSourceSchema = z.enum(["google-calendar", "gmail", "github", "linear", "ics", "microsoft", "strava", "oura"]);
const removedSchema = z.object({
  tasks: z.number().int().nonnegative(), intents: z.number().int().nonnegative(), commitments: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(), proposals: z.number().int().nonnegative(), evidence: z.number().int().nonnegative(),
  patterns: z.number().int().nonnegative(), derived: z.number().int().nonnegative(), effects: z.number().int().nonnegative(),
  connectors: z.number().int().nonnegative(), receipts: z.number().int().nonnegative(),
}).strict();
const revocationReceiptSchema = z.object({
  schemaVersion: z.literal(1), source: connectorSourceSchema, consentRevision: z.number().int().nonnegative(),
  revokedAt: z.string().max(40), localTokenDeleted: z.boolean(), removed: removedSchema,
}).strict();
const tokenRegistrySchema = z.record(commandIdSchema, tokenEnvelopeV1Schema).superRefine((tokens, context) => {
  if (Object.keys(tokens).length > 20 || Object.keys(tokens).some((source) => !connectorSourceSchema.safeParse(source).success)) context.addIssue({ code: "custom", message: "Invalid connector token registry" });
});
const revocationRegistrySchema = z.record(commandIdSchema, revocationReceiptSchema).superRefine((receipts, context) => {
  if (Object.keys(receipts).length > 10_000) context.addIssue({ code: "custom", message: "Too many connector revocation receipts" });
});
const connectorEffectRegistrySchema = z.record(commandIdSchema, z.custom<EffectState>(isEffectState)).superRefine((effects, context) => {
  if (Object.keys(effects).length > 10_000 || Object.entries(effects).some(([effectId, state]) => effectId !== state.effectId)) context.addIssue({ code: "custom", message: "Invalid connector effect registry" });
});
const connectorCommandSourceSchema = z.record(commandIdSchema, connectorSourceSchema).superRefine((sources, context) => {
  if (Object.keys(sources).length > 10_000) context.addIssue({ code: "custom", message: "Too many connector command sources" });
});
const connectorConsentRevisionSchema = z.record(commandIdSchema, z.number().int().nonnegative()).superRefine((revisions, context) => {
  if (Object.keys(revisions).length > 20 || Object.keys(revisions).some((source) => !connectorSourceSchema.safeParse(source).success)) context.addIssue({ code: "custom", message: "Invalid connector consent revisions" });
});
const envelopeDataSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  payload: localStateV1Schema,
  idempotencyKeys: registrySchema,
  connectorTokens: tokenRegistrySchema.optional(),
  connectorRevocations: revocationRegistrySchema.optional(),
  connectorEffects: connectorEffectRegistrySchema.optional(),
  connectorCommandSources: connectorCommandSourceSchema.optional(),
  connectorConsentRevisions: connectorConsentRevisionSchema.optional(),
}).strict();
const envelopeSchema = envelopeDataSchema.extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type EnvelopeData = z.infer<typeof envelopeDataSchema>;
type Envelope = z.infer<typeof envelopeSchema>;
type FaultAt = "before-write" | "after-write" | "after-file-fsync" | "before-rename" | "after-rename";
export type CommitResult =
  | { ok: true; receipt: { revision: number; resultId: string }; duplicate?: true }
  | { ok: false; code: "INVALID_COMMAND" | "IDEMPOTENCY_MISMATCH" | "INVALID_RECEIPT" | "STALE_REVISION" | "STORE_WRITE_FAILED" };
export type CommitInput = { expectedRevision: number; commandId: string; idempotencyKey: string; nextState: LocalStateV1 };
export type ConnectorSource = z.infer<typeof connectorSourceSchema>;
export type ConnectorRemoved = z.infer<typeof removedSchema>;
export type ConnectorRevocationReceipt = z.infer<typeof revocationReceiptSchema>;
export type ConnectorMutation = Readonly<{ expectedRevision: number; commandId: string; idempotencyKey: string; resultId?: string }>;
export type ConnectorTokenCommit = ConnectorMutation & Readonly<{
  source: ConnectorSource; envelope: TokenEnvelopeV1; consentRevision: number; capabilities: readonly string[]; connectedAt: string;
}>;
export type ConnectorRevocationCommit = ConnectorMutation & Readonly<{ source: ConnectorSource; consentRevision: number; at: string }>;
export type ConnectorEffectCommit = ConnectorMutation & Readonly<{ state: EffectState }>;
export type ConnectorSyncCommit = ConnectorMutation & Readonly<{
  source: "google-calendar" | "github" | "linear" | "gmail"; consentRevision: number; freshness: FreshnessV1;
  tasks?: readonly NormalizedTaskV1[]; commitments?: readonly NormalizedCommitmentV1[];
}>;
export type GmailSelectionCommit = ConnectorMutation & Readonly<{ consentRevision:number; freshness:FreshnessV1; commitments:readonly NormalizedCommitmentV1[] }>;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const canonicalInstant = (value: unknown): value is string => {
  try { return typeof value === "string" && value.endsWith("Z") && Temporal.Instant.from(value).toString() === value; } catch { return false; }
};
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
    if (Object.keys(data.connectorRevocations ?? {}).some((commandId) => !own(data.payload.commandReceipts, commandId))) throw new Error("STORE_RECOVERY_REQUIRED");
    if (Object.keys(data.connectorCommandSources ?? {}).some((commandId) => !own(data.payload.commandReceipts, commandId))) throw new Error("STORE_RECOVERY_REQUIRED");
    return envelope;
  }

  private commandReceipt(current: Envelope, commandId: string, idempotencyKey: string) {
    if (!own(current.payload.commandReceipts, commandId)) return null;
    if (current.idempotencyKeys[commandId] !== idempotencyKey) throw new Error("IDEMPOTENCY_MISMATCH");
    return current.payload.commandReceipts[commandId];
  }

  private nextCommandState(current: Envelope, input: ConnectorMutation, mutate: (state: LocalStateV1) => void) {
    if (!commandIdSchema.safeParse(input.commandId).success || !boundedValue.safeParse(input.idempotencyKey).success
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("INVALID_COMMAND");
    if (Object.entries(current.idempotencyKeys).some(([commandId, key]) => key === input.idempotencyKey && commandId !== input.commandId)) throw new Error("IDEMPOTENCY_MISMATCH");
    if (input.expectedRevision !== current.revision) throw new Error("STALE_REVISION");
    const state = structuredClone(current.payload), resultId = input.resultId ?? randomUUID();
    mutate(state); state.revision = current.revision + 1;
    state.commandReceipts[input.commandId] = { revision: state.revision, resultId };
    return { state: localStateV1Schema.parse(state), resultId };
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

  async loadConnectorToken(source: ConnectorSource): Promise<TokenEnvelopeV1 | null> {
    return this.serialized(async () => structuredClone((await this.readEnvelope()).connectorTokens?.[source] ?? null));
  }

  async commitConnectorToken(input: ConnectorTokenCommit) {
    return this.serialized(async () => {
      if (!connectorSourceSchema.safeParse(input.source).success || !tokenEnvelopeV1Schema.safeParse(input.envelope).success
        || !Number.isSafeInteger(input.consentRevision) || input.consentRevision < 0 || !Array.isArray(input.capabilities)
        || input.capabilities.length > 100 || input.capabilities.some((value) => !boundedValue.safeParse(value).success)
        || !canonicalInstant(input.connectedAt)) throw new Error("INVALID_COMMAND");
      const current = await this.readEnvelope(), duplicate = this.commandReceipt(current, input.commandId, input.idempotencyKey);
      if (duplicate) return { receipt: duplicate, duplicate: true as const };
      const lastConsentRevision=current.connectorConsentRevisions?.[input.source]??current.payload.connections[input.source]?.consentRevision;if(lastConsentRevision!==undefined&&input.consentRevision<=lastConsentRevision)throw new Error("STALE_CONSENT_REVISION");
      const { state } = this.nextCommandState(current, input, (next) => {
        next.connections[input.source] = { capabilities: [...input.capabilities], consentRevision: input.consentRevision, freshness: { schemaVersion: 1, fetchedAt: input.connectedAt, sourceUpdatedAt: null, expiresAt: null, state: "fresh" } };
      });
      const envelope = this.validate(this.seal({
        schemaVersion: 1, revision: state.revision, payload: state,
        idempotencyKeys: { ...current.idempotencyKeys, [input.commandId]: input.idempotencyKey },
        connectorTokens: { ...current.connectorTokens, [input.source]: structuredClone(input.envelope) },
        connectorRevocations: current.connectorRevocations,
        connectorEffects: current.connectorEffects,
        connectorCommandSources: { ...current.connectorCommandSources, [input.commandId]: input.source },
        connectorConsentRevisions: { ...current.connectorConsentRevisions, [input.source]: input.consentRevision },
      }));
      await this.writeAtomic(envelope);
      return { receipt: state.commandReceipts[input.commandId] };
    });
  }

  async revokeConnectorSource(input: ConnectorRevocationCommit): Promise<ConnectorRevocationReceipt> {
    return this.serialized(async () => {
      if (!connectorSourceSchema.safeParse(input.source).success || !Number.isSafeInteger(input.consentRevision) || input.consentRevision < 0 || !canonicalInstant(input.at)) throw new Error("INVALID_COMMAND");
      const current = await this.readEnvelope(), duplicate = this.commandReceipt(current, input.commandId, input.idempotencyKey);
      if (duplicate) {
        const receipt = current.connectorRevocations?.[input.commandId]; if (!receipt) throw new Error("STORE_RECOVERY_REQUIRED");
        return structuredClone(receipt);
      }
      const lastConsentRevision=current.connectorConsentRevisions?.[input.source]??current.payload.connections[input.source]?.consentRevision;if(lastConsentRevision===undefined||input.consentRevision<=lastConsentRevision)throw new Error("STALE_CONSENT_REVISION");
      const sourceCommands=Object.entries(current.connectorCommandSources??{}).filter(([,source])=>source===input.source).map(([commandId])=>commandId);
      const sourceCommandSet=new Set(sourceCommands);
      const removedTaskIds = new Set(current.payload.tasks.filter((item) => item.source === input.source || item.provenance.source === input.source).map((item) => item.id));
      const before = current.payload, tokenDeleted = own(current.connectorTokens ?? {}, input.source);
      const { state, resultId } = this.nextCommandState(current, input, (next) => {
        delete next.connections[input.source];
        next.tasks = next.tasks.filter((item) => !removedTaskIds.has(item.id));
        next.schedulingIntents = next.schedulingIntents.filter((item) => !removedTaskIds.has(item.taskId));
        next.commitments = next.commitments.filter((item) => item.provenance.source !== input.source);
        next.observations = next.observations.filter((item) => item.provenance.source !== input.source);
        next.proposals = next.proposals.filter((item) => !removedTaskIds.has(item.taskId));
        for(const commandId of sourceCommands)delete next.commandReceipts[commandId];
      });
      const removed: ConnectorRemoved = {
        tasks: before.tasks.length - state.tasks.length, intents: before.schedulingIntents.length - state.schedulingIntents.length,
        commitments: before.commitments.length - state.commitments.length, observations: before.observations.length - state.observations.length,
        proposals: before.proposals.length - state.proposals.length, evidence: 0, patterns: 0, derived: 0,
        effects: input.source === "google-calendar" ? Object.values(current.connectorEffects ?? {}).filter((effect) => effect.provider === "google-calendar").length : 0,
        connectors: own(before.connections, input.source) ? 1 : 0, receipts: sourceCommands.length,
      };
      const receipt = revocationReceiptSchema.parse({ schemaVersion: 1, source: input.source, consentRevision: input.consentRevision, revokedAt: input.at, localTokenDeleted: tokenDeleted, removed });
      const tokens = { ...current.connectorTokens }; delete tokens[input.source];
      const effects = input.source === "google-calendar" ? {} : current.connectorEffects;
      const idempotencyKeys=Object.fromEntries(Object.entries(current.idempotencyKeys).filter(([commandId])=>!sourceCommandSet.has(commandId)));
      const commandSources=Object.fromEntries(Object.entries(current.connectorCommandSources??{}).filter(([commandId])=>!sourceCommandSet.has(commandId)));
      const revocations=Object.fromEntries(Object.entries(current.connectorRevocations??{}).filter(([commandId])=>!sourceCommandSet.has(commandId)));
      const envelope = this.validate(this.seal({
        schemaVersion: 1, revision: state.revision, payload: state,
        idempotencyKeys: { ...idempotencyKeys, [input.commandId]: input.idempotencyKey },
        connectorTokens: tokens, connectorRevocations: { ...revocations, [input.commandId]: receipt }, connectorEffects: effects,
        connectorCommandSources: { ...commandSources, [input.commandId]: input.source },
        connectorConsentRevisions: { ...current.connectorConsentRevisions, [input.source]: input.consentRevision },
      }));
      if (state.commandReceipts[input.commandId]!.resultId !== resultId) throw new Error("STORE_WRITE_FAILED");
      await this.writeAtomic(envelope);
      return structuredClone(receipt);
    });
  }

  async loadConnectorEffect(effectId: string): Promise<EffectState | null> {
    return this.serialized(async () => structuredClone((await this.readEnvelope()).connectorEffects?.[effectId] ?? null));
  }

  async commitConnectorSync(input: ConnectorSyncCommit) {
    return this.serialized(async () => {
      const current=await this.readEnvelope(),duplicate=this.commandReceipt(current,input.commandId,input.idempotencyKey);if(duplicate)return{receipt:duplicate,duplicate:true as const};
      const connection=current.payload.connections[input.source],capability=input.source==="google-calendar"?"calendar.read":input.source==="gmail"?"gmail.selected-message.read":"task.sync";
      if(!connection||connection.consentRevision!==input.consentRevision||connection.freshness.state==="revoked"||!connection.capabilities.includes(capability)||(input.source!=="gmail"&&!current.connectorTokens?.[input.source]))throw new Error("CONNECTOR_SYNC_NOT_AUTHORIZED");
      const {state}=this.nextCommandState(current,input,(next)=>{
        const taskIds=new Set(next.tasks.filter((item)=>item.provenance.source===input.source).map((item)=>item.id));
        if(input.tasks){next.tasks=[...next.tasks.filter((item)=>item.provenance.source!==input.source),...input.tasks];const activeIds=new Set(input.tasks.map((item)=>item.id));for(const id of activeIds)taskIds.delete(id);next.schedulingIntents=next.schedulingIntents.filter((item)=>!taskIds.has(item.taskId));next.proposals=next.proposals.filter((item)=>!taskIds.has(item.taskId));}
        if(input.commitments)next.commitments=[...next.commitments.filter((item)=>item.provenance.source!==input.source),...input.commitments];
        next.connections[input.source]={...connection,freshness:structuredClone(input.freshness)};
      });
      const envelope=this.validate(this.seal({schemaVersion:1,revision:state.revision,payload:state,idempotencyKeys:{...current.idempotencyKeys,[input.commandId]:input.idempotencyKey},connectorTokens:current.connectorTokens,connectorRevocations:current.connectorRevocations,connectorEffects:current.connectorEffects,connectorCommandSources:{...current.connectorCommandSources,[input.commandId]:input.source},connectorConsentRevisions:current.connectorConsentRevisions}));
      await this.writeAtomic(envelope);return{receipt:state.commandReceipts[input.commandId]};
    });
  }

  async commitGmailSelection(input:GmailSelectionCommit){return this.serialized(async()=>{const current=await this.readEnvelope(),duplicate=this.commandReceipt(current,input.commandId,input.idempotencyKey);if(duplicate)return{receipt:duplicate,duplicate:true as const};const connection=current.payload.connections.gmail,last=current.connectorConsentRevisions?.gmail;if(connection?connection.consentRevision!==input.consentRevision:last!==undefined&&input.consentRevision<=last)throw new Error("STALE_CONSENT_REVISION");if(input.commitments.some((item)=>item.provenance.source!=="gmail"||item.provenance.consentRevision!==input.consentRevision))throw new Error("INVALID_GMAIL_SELECTION");const{state}=this.nextCommandState(current,input,(next)=>{next.commitments=[...next.commitments.filter((item)=>item.provenance.source!=="gmail"),...input.commitments];next.connections.gmail={capabilities:["gmail.selected-message.read"],consentRevision:input.consentRevision,freshness:structuredClone(input.freshness)};});const envelope=this.validate(this.seal({schemaVersion:1,revision:state.revision,payload:state,idempotencyKeys:{...current.idempotencyKeys,[input.commandId]:input.idempotencyKey},connectorTokens:current.connectorTokens,connectorRevocations:current.connectorRevocations,connectorEffects:current.connectorEffects,connectorCommandSources:{...current.connectorCommandSources,[input.commandId]:"gmail"},connectorConsentRevisions:{...current.connectorConsentRevisions,gmail:input.consentRevision}}));await this.writeAtomic(envelope);return{receipt:state.commandReceipts[input.commandId]};});}

  async commitConnectorEffect(input: ConnectorEffectCommit) {
    return this.serialized(async () => {
      if (!isEffectState(input.state)) throw new Error("INVALID_COMMAND");
      const current = await this.readEnvelope(), duplicate = this.commandReceipt(current, input.commandId, input.idempotencyKey);
      if (duplicate) return { receipt: duplicate, state: structuredClone(current.connectorEffects?.[input.state.effectId] ?? input.state), duplicate: true as const };
      const connection=current.payload.connections["google-calendar"];
      if(!current.connectorTokens?.["google-calendar"]||!connection||connection.freshness.state==="revoked"||!connection.capabilities.includes("calendar.event.write"))throw new Error("GOOGLE_CALENDAR_WRITE_NOT_AUTHORIZED");
      const { state } = this.nextCommandState(current, input, (next) => {
        const proposal = next.proposals.find((item) => item.id === input.state.proposalId);
        if (!proposal) throw new Error("INVALID_EFFECT_PROPOSAL");
        const succeeded = ["succeeded", "reconciliation-found", "retry-completed"].includes(input.state.status);
        proposal.status = succeeded ? "succeeded" : input.state.status === "unknown" || input.state.status === "confirmed-absent" || input.state.status === "retry-authorized" ? "unknown" : "effect-pending";
      });
      const envelope = this.validate(this.seal({
        schemaVersion: 1, revision: state.revision, payload: state,
        idempotencyKeys: { ...current.idempotencyKeys, [input.commandId]: input.idempotencyKey }, connectorTokens: current.connectorTokens,
        connectorRevocations: current.connectorRevocations, connectorEffects: { ...current.connectorEffects, [input.state.effectId]: structuredClone(input.state) },
        connectorCommandSources: { ...current.connectorCommandSources, [input.commandId]: "google-calendar" }, connectorConsentRevisions: current.connectorConsentRevisions,
      }));
      await this.writeAtomic(envelope);
      return { receipt: state.commandReceipts[input.commandId], state: structuredClone(input.state) };
    });
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
        const envelope = this.validate(this.seal({ schemaVersion: 1, revision: nextState.revision, payload: nextState, idempotencyKeys,
          connectorTokens: current.connectorTokens, connectorRevocations: current.connectorRevocations, connectorEffects: current.connectorEffects,
          connectorCommandSources: current.connectorCommandSources, connectorConsentRevisions: current.connectorConsentRevisions }));
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
