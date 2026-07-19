import { createHash } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";

import { normalizedCommitmentV1Schema, type NormalizedCommitmentV1 } from "../../contracts/v1";
import { IcsBoundaryError, type IcsPreview } from "../../adapters/ics";

export type IcsApprovalCommand = Readonly<{
  schemaVersion: 1; commandId: string; idempotencyKey: string; expectedRevision: number; previewHash: string; approved: true;
}>;
export type IcsApprovalReceipt = Readonly<{
  schemaVersion: 1; commandId: string; idempotencyKey: string; previewHash: string; revision: number; importedCount: number;
}>;
export type IcsImportState = Readonly<{
  schemaVersion: 1; revision: number; commitments: readonly NormalizedCommitmentV1[];
  receipts: Readonly<Record<string, Readonly<{ fingerprint: string; receipt: IcsApprovalReceipt }>>>;
}>;

const HASH = /^[a-f0-9]{64}$/;
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exact = (value: object, keys: readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const canonicalInstant = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  try { return Temporal.Instant.from(value).toString() === value; } catch { return false; }
};
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
const fail = (): never => { throw new IcsBoundaryError("INVALID_APPROVAL"); };

export const emptyIcsImportState = (): IcsImportState => freeze({ schemaVersion: 1, revision: 0, commitments: [], receipts: {} });

const validState = (state: IcsImportState) => {
  if (!state || !exact(state, ["schemaVersion", "revision", "commitments", "receipts"]) || state.schemaVersion !== 1 || !safe(state.revision)
    || !Array.isArray(state.commitments) || state.commitments.length > 2_000 || !state.receipts || typeof state.receipts !== "object" || Array.isArray(state.receipts)
    || Object.keys(state.receipts).length > 2_000) return false;
  try { state.commitments.forEach((item) => normalizedCommitmentV1Schema.parse(item)); } catch { return false; }
  return Object.entries(state.receipts).every(([key, stored]) => text(key) && stored && exact(stored, ["fingerprint", "receipt"])
    && HASH.test(stored.fingerprint) && exact(stored.receipt, ["schemaVersion", "commandId", "idempotencyKey", "previewHash", "revision", "importedCount"])
    && stored.receipt.schemaVersion === 1 && text(stored.receipt.commandId) && stored.receipt.idempotencyKey === key
    && HASH.test(stored.receipt.previewHash) && safe(stored.receipt.revision) && safe(stored.receipt.importedCount));
};

const validPreview = (preview: IcsPreview) => {
  if (!preview || !exact(preview, ["schemaVersion", "previewOnly", "previewHash", "events"]) || preview.schemaVersion !== 1
    || preview.previewOnly !== true || !HASH.test(preview.previewHash) || !Array.isArray(preview.events) || preview.events.length > 2_000
    || createHash("sha256").update(JSON.stringify(preview.events)).digest("hex") !== preview.previewHash) return false;
  const identities = new Set<string>(), commitmentIds = new Set<string>();
  let previous: IcsPreview["events"][number] | undefined;
  for (const event of preview.events) {
    if (!event || !exact(event, ["uid", "recurrenceId", "status", "commitment"]) || !text(event.uid)
      || event.recurrenceId !== null && !canonicalInstant(event.recurrenceId) || !["confirmed", "tentative"].includes(event.status)) return false;
    const identity = `${event.uid}\0${event.recurrenceId ?? "master"}`;
    if (identities.has(identity) || commitmentIds.has(event.commitment?.id)) return false;
    try { normalizedCommitmentV1Schema.parse(event.commitment); } catch { return false; }
    if (event.commitment.provenance.source !== "ics" || event.commitment.provenance.sourceEntityId !== (event.recurrenceId === null ? event.uid : `${event.uid}#${event.recurrenceId}`)
      || event.commitment.participantSetKey !== null || event.commitment.kind !== "calendar-event" || event.commitment.startAt === null || event.commitment.endAt === null) return false;
    if (previous) {
      const order = Temporal.Instant.compare(previous.commitment.startAt!, event.commitment.startAt) || compare(previous.uid, event.uid) || compare(previous.recurrenceId ?? "", event.recurrenceId ?? "");
      if (order > 0) return false;
    }
    identities.add(identity); commitmentIds.add(event.commitment.id); previous = event;
  }
  return true;
};

export const approvePreview = (state: IcsImportState, preview: IcsPreview, command: IcsApprovalCommand): Readonly<{ nextState: IcsImportState; receipt: IcsApprovalReceipt }> => {
  if (!validState(state) || !validPreview(preview)
    || !command || !exact(command, ["schemaVersion", "commandId", "idempotencyKey", "expectedRevision", "previewHash", "approved"])
    || command.schemaVersion !== 1 || !text(command.commandId) || !text(command.idempotencyKey) || !safe(command.expectedRevision)
    || !HASH.test(command.previewHash) || command.previewHash !== preview.previewHash || command.approved !== true) return fail();
  const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const prior = state.receipts[command.idempotencyKey];
  if (prior) {
    if (prior.fingerprint !== fingerprint) return fail();
    return freeze({ nextState: state, receipt: prior.receipt });
  }
  if (command.expectedRevision !== state.revision) return fail();
  const existing = new Set(state.commitments.map((item) => item.id));
  const incoming = preview.events.map((event) => event.commitment);
  if (incoming.some((item) => existing.has(item.id)) || state.commitments.length + incoming.length > 2_000) return fail();
  const revision = state.revision + 1;
  const receipt: IcsApprovalReceipt = {
    schemaVersion: 1, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
    previewHash: command.previewHash, revision, importedCount: incoming.length,
  };
  const nextState: IcsImportState = {
    schemaVersion: 1,
    revision,
    commitments: [...state.commitments, ...incoming],
    receipts: { ...state.receipts, [command.idempotencyKey]: { fingerprint, receipt } },
  };
  return freeze({ nextState, receipt });
};
