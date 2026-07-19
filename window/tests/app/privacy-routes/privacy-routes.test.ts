import { describe, expect, it } from "vitest";

import { POST as explain } from "../../../src/app/api/v1/explanation/route";
import { POST as exportRoute } from "../../../src/app/api/v1/privacy/export/route";
import { POST as transition } from "../../../src/app/api/v1/privacy/transition/route";
import type { PrivacyStateV1 } from "../../../src/application/privacy";

const at = "2026-07-23T15:00:00Z";
const state = (): PrivacyStateV1 => ({ schemaVersion: 1, revision: 0, profileId: "private", timeZone: "America/Chicago", profileDeleted: false, connectors: [], tasks: [], schedulingIntents: [], commitments: [], observations: [], proposals: [], evidence: [], patterns: [], effectAuthority: [], proposalReceipts: [], focusSettings: { enabled: false, windows: [] }, commandReceipts: {} });

describe("privacy and explanation routes", () => {
  it("returns a deterministic private explanation without agent authority", async () => {
    const response = await explain(new Request("http://localhost/api/v1/explanation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, proposalId: "10000000-0000-4000-8000-000000000001", score: 20, evidence: [{ kind: "capacity-fit", summary: "Fixture capacity", weight: 20, freshness: { schemaVersion: 1, fetchedAt: at, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } }], alternatives: [], limitations: [], forbiddenAuthority: true }) }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ source: "deterministic", score: 20 });
  });

  it("exports only client-held state and applies a pure revision transition", async () => {
    const exported = await exportRoute(new Request("http://localhost/api/v1/privacy/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: state() }) }));
    expect(exported.status).toBe(200); expect(exported.headers.get("content-disposition")).toContain("privacy-export.json");
    const result = await transition(new Request("http://localhost/api/v1/privacy/transition", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: state(), command: { schemaVersion: 1, kind: "prune", commandId: "route-command", idempotencyKey: "route-key", expectedRevision: 0, at } }) }));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toMatchObject({ state: { revision: 1 }, receipt: { kind: "prune", revision: 1 } });
  });

  it("fails closed on malformed or stale requests", async () => {
    expect((await explain(new Request("http://localhost", { method: "POST", body: "{}" }))).status).toBe(400);
    const response = await transition(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: state(), command: { schemaVersion: 1, kind: "prune", commandId: "stale", idempotencyKey: "stale", expectedRevision: 2, at } }) }));
    expect(response.status).toBe(409);
  });

  it("rejects declared and actual oversize bodies plus duplicate top-level keys before parsing", async () => {
    const requests: [typeof explain | typeof exportRoute | typeof transition, string][] = [
      [explain, '{"schemaVersion":1,"schemaVersion":1}'],
      [exportRoute, '{"state":{},"state":{}}'],
      [transition, '{"state":{},"command":{},"command":{}}'],
    ];
    for (const [handler, body] of requests) {
      expect((await handler(new Request("http://localhost", { method: "POST", body, headers: { "content-type": "application/json" } }))).status).toBe(400);
      expect((await handler(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-length": "99999999" } }))).status).toBe(413);
    }
    const oversized = `{"padding":"${"é".repeat(40_000)}"}`;
    expect((await explain(new Request("http://localhost", { method: "POST", body: oversized }))).status).toBe(413);
    expect((await exportRoute(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-length": "1" } }))).status).toBe(400);
  });

  it("rejects client-minted remote revocation outcomes", async () => {
    const response = await transition(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: state(), command: { schemaVersion: 1, kind: "delete-source", commandId: "overclaim", idempotencyKey: "overclaim", expectedRevision: 0, at, source: "github", remoteRevocation: "confirmed" } }) }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('"remoteRevocation":"confirmed"');
  });
});
