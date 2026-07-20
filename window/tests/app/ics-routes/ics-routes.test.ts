import { describe, expect, it } from "vitest";

import { POST as approve } from "../../../src/app/api/v1/ics/approve/route";
import { POST as exportRoute } from "../../../src/app/api/v1/ics/export/route";
import { POST as previewRoute } from "../../../src/app/api/v1/ics/preview/route";

const calendar = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:route\r\nDTSTART:20260723T180000Z\r\nDTEND:20260723T183000Z\r\nSUMMARY:Route preview\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

describe("ICS routes", () => {
  it("previews, approves client-held state, and exports with private no-store headers", async () => {
    const previewResponse = await previewRoute(new Request("http://localhost/api/v1/ics/preview", { method: "POST", body: calendar, headers: { "x-consent-revision": "1", "x-fetched-at": "2026-07-23T15:00:00Z" } }));
    expect(previewResponse.status).toBe(200); expect(previewResponse.headers.get("cache-control")).toBe("private, no-store");
    const preview = await previewResponse.json() as { previewHash: string };
    const state = { schemaVersion: 1, revision: 0, commitments: [], receipts: {} };
    const command = { schemaVersion: 1, commandId: "route-command", idempotencyKey: "route-key", expectedRevision: 0, previewHash: preview.previewHash, approved: true };
    const approval = await approve(new Request("http://localhost/api/v1/ics/approve", { method: "POST", body: JSON.stringify({ state, preview, command }), headers: { "content-type": "application/json" } }));
    expect(approval.status).toBe(200);
    const exported = await exportRoute(new Request("http://localhost/api/v1/ics/export", { method: "POST", body: JSON.stringify({ items: [{ id: "route-local", source: "local", approved: true, title: "Route export", startAt: "2026-07-23T18:00:00Z", endAt: "2026-07-23T18:30:00Z" }] }), headers: { "content-type": "application/json" } }));
    expect(exported.status).toBe(200); expect(exported.headers.get("content-type")).toBe("text/calendar; charset=utf-8"); expect(await exported.text()).toContain("UID:route-local@capacity-scheduling.local");
  });

  it("stops oversized bodies before buffering and rejects content-length mismatches", async () => {
    const tooLarge = String(5 * 1_024 * 1_024 + 1);
    for (const handler of [previewRoute, approve, exportRoute]) {
      expect((await handler(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-length": tooLarge } }))).status).toBe(413);
      expect((await handler(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-length": "1" } }))).status).toBe(400);
    }
    expect((await previewRoute(new Request("http://localhost", { method: "POST", body: new Uint8Array(5 * 1_024 * 1_024 + 1) }))).status).toBe(413);
  });

  it("rejects duplicate top-level JSON keys", async () => {
    expect((await approve(new Request("http://localhost", { method: "POST", body: '{"state":{},"state":{},"preview":{},"command":{}}' }))).status).toBe(400);
    expect((await exportRoute(new Request("http://localhost", { method: "POST", body: '{"items":[],"items":[]}' }))).status).toBe(400);
  });
});
