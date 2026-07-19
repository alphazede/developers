import { describe, expect, it } from "vitest";

import { parsePreview } from "../../../src/adapters/ics";
import { approvePreview, emptyIcsImportState } from "../../../src/application/imports";

const bytes = new TextEncoder().encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:approved\r\nDTSTART:20260723T180000Z\r\nDTEND:20260723T183000Z\r\nSUMMARY:Approved preview\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");

describe("ICS approval", () => {
  it("is expected-revision, idempotent, pure, and advances no state on failure", async () => {
    const preview = await parsePreview(bytes, { consentRevision: 1, fetchedAt: "2026-07-23T15:00:00Z" });
    const state = emptyIcsImportState(), before = structuredClone(state);
    const command = { schemaVersion: 1 as const, commandId: "command-a", idempotencyKey: "approval-a", expectedRevision: 0, previewHash: preview.previewHash, approved: true as const };
    const first = approvePreview(state, preview, command);
    expect(state).toEqual(before);
    expect(first).toMatchObject({ nextState: { revision: 1, commitments: [{ title: "Approved preview" }] }, receipt: { revision: 1, importedCount: 1 } });
    expect(approvePreview(first.nextState, preview, command)).toEqual({ nextState: first.nextState, receipt: first.receipt });
    expect(Object.isFrozen(first.nextState.commitments[0])).toBe(true);
    const committed = structuredClone(first.nextState);
    expect(() => approvePreview(first.nextState, preview, { ...command, idempotencyKey: "approval-b", expectedRevision: 1 })).toThrowError("INVALID_APPROVAL");
    expect(() => approvePreview(state, preview, { ...command, expectedRevision: 1 })).toThrowError("INVALID_APPROVAL");
    expect(() => approvePreview(first.nextState, preview, { ...command, commandId: "forged" })).toThrowError("INVALID_APPROVAL");
    expect(first.nextState).toEqual(committed);
    const originalEvent = preview.events[0]!;
    const forgedEvents = [{ ...originalEvent, commitment: { ...originalEvent.commitment, provenance: { ...originalEvent.commitment.provenance, source: "microsoft" as const } } }];
    const forged = { ...preview, events: forgedEvents, previewHash: createHash("sha256").update(JSON.stringify(forgedEvents)).digest("hex") };
    expect(() => approvePreview(state, forged as never, { ...command, previewHash: forged.previewHash })).toThrowError("INVALID_APPROVAL");
    expect(() => approvePreview({ ...state, receipts: { malformed: { fingerprint: "0".repeat(64), receipt: undefined } } } as never, preview, command)).toThrowError("INVALID_APPROVAL");
    expect(state).toEqual(before);
  });
});
import { createHash } from "node:crypto";
