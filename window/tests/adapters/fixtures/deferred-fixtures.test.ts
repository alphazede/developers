import { describe, expect, it } from "vitest";

import microsoft from "../../../fixtures/connectors/microsoft/calendar.json";
import oura from "../../../fixtures/connectors/oura/readiness.json";
import strava from "../../../fixtures/connectors/strava/activity.json";
import { AdapterBoundaryError } from "../../../src/adapters/shared";
import { fixtureStatus, normalizeMicrosoftFixture, normalizeOuraFixture, normalizeStravaFixture } from "../../../src/adapters/fixtures";

describe("deferred fixture adapters", () => {
  it("declares exact fixture-only capabilities without live methods", () => {
    expect(fixtureStatus("microsoft", microsoft.fetchedAt, 1)).toMatchObject({ status: "fixture", mode: "fixture", liveAvailable: false, capabilities: ["calendar.fixture.read"] });
    expect(fixtureStatus("strava", strava.fetchedAt, 1)).toMatchObject({ status: "fixture", capabilities: ["activity.fixture.read"] });
    expect(fixtureStatus("oura", oura.fetchedAt, 1)).toMatchObject({ status: "fixture", capabilities: ["readiness.fixture.read"] });
    expect(JSON.stringify([fixtureStatus("microsoft", microsoft.fetchedAt, 1), fixtureStatus("strava", strava.fetchedAt, 1), fixtureStatus("oura", oura.fetchedAt, 1)])).not.toMatch(/oauth|connect|live available/i);
  });

  it("normalizes strict Microsoft, Strava, and Oura evidence in stable order", async () => {
    const commitments = await normalizeMicrosoftFixture(microsoft);
    const activity = await normalizeStravaFixture(strava);
    const readiness = await normalizeOuraFixture(oura);
    expect(commitments.map((item) => [item.startAt, item.provenance.source, item.provenance.freshness.state])).toEqual([
      ["2026-07-23T18:00:00Z", "microsoft", "fixture"], ["2026-07-23T19:30:00Z", "microsoft", "fixture"],
    ]);
    expect(activity.map((item) => [item.observedAt, item.signal, item.provenance.source])).toEqual([
      ["2026-07-21T13:00:00Z", "activity", "strava"], ["2026-07-22T13:00:00Z", "activity", "strava"],
    ]);
    expect(readiness.map((item) => [item.observedAt, item.signal, item.provenance.source])).toEqual([
      ["2026-07-20T12:00:00Z", "readiness", "oura"], ["2026-07-22T12:00:00Z", "readiness", "oura"],
    ]);
    expect(await normalizeMicrosoftFixture({ ...structuredClone(microsoft), pages: [...microsoft.pages].reverse() })).toEqual(commitments);
  });

  it("isolates malformed and future-version failure to the requested fixture source", async () => {
    await expect(normalizeMicrosoftFixture({ ...microsoft, schemaVersion: 2 })).rejects.toMatchObject({ source: "microsoft", code: "UNSUPPORTED_CONTRACT" });
    await expect(normalizeStravaFixture({ ...strava, source: "oura" })).rejects.toMatchObject({ source: "strava", code: "MALFORMED_SOURCE" });
    await expect(normalizeOuraFixture({ ...oura, pages: [{ records: [oura.pages[0]!.records[0], oura.pages[0]!.records[0]] }] })).rejects.toBeInstanceOf(AdapterBoundaryError);
    expect((await normalizeMicrosoftFixture(microsoft))).toHaveLength(2);
  });
});
