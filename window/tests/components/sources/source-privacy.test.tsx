// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { buildSourcePrivacyRows, mergeSourceManifests } from "../../../src/components/sources/source-model";
import { SourcesPrivacySection } from "../../../src/components/sources/sources-privacy-section";
import type { ConnectorManifest } from "../../../src/application/connectors";

afterEach(cleanup);
const freshness = { schemaVersion: 1 as const, fetchedAt: "2026-07-23T15:00:00Z", sourceUpdatedAt: null, expiresAt: null, state: "fixture" as const };
const fixtures: ConnectorManifest[] = [
  { schemaVersion: 1, source: "microsoft", mode: "fixture", capabilities: ["calendar.fixture.read"], consentRevision: 0, freshness },
  { schemaVersion: 1, source: "strava", mode: "fixture", capabilities: ["activity.fixture.read"], consentRevision: 0, freshness },
  { schemaVersion: 1, source: "oura", mode: "fixture", capabilities: ["readiness.fixture.read"], consentRevision: 0, freshness },
];
const explanation = { schemaVersion: 1 as const, score: 82, heading: "Why this time was suggested", bullets: ["Evidence data: capacity-fit (32 points, fixture)."], source: "deterministic" as const };

describe("SourcesPrivacySection", () => {
  it("renders independent exact source truth without offering Apple credentials or Gmail OAuth", () => {
    render(<SourcesPrivacySection rows={buildSourcePrivacyRows(fixtures)} explanation={explanation} />);
    for (const name of ["Google Calendar", "Selected Gmail message", "GitHub", "Linear", "ICS file", "Microsoft", "Strava", "Oura"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(screen.getByText("Normalized payload seam for a separately configured Workspace add-on current-message grant")).toBeTruthy();
    expect(screen.getByText("Normalized title and deadline plus message/thread provenance; the selected fragment and raw body are discarded.")).toBeTruthy();
    expect(screen.getByText(/This route does not validate a Google-issued grant; normal Gmail OAuth and broad Gmail scopes are disabled/)).toBeTruthy();
    expect(screen.getByText("Apple-compatible calendar file path; no Apple credentials requested.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect apple/i })).toBeNull();
    expect(screen.getAllByText(/Fixture only/)).toHaveLength(3);
    expect(screen.getAllByText(/Not configured/).length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByRole("button").filter((button) => !(button as HTMLButtonElement).disabled).every((button) => button.textContent?.startsWith("Preview"))).toBe(true);
  });

  it("previews and confirms local actions with live announcements and focus return", async () => {
    const user = userEvent.setup();
    render(<SourcesPrivacySection rows={buildSourcePrivacyRows(fixtures)} explanation={explanation} />);
    const trigger = screen.getByRole("button", { name: "Preview ICS import" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Preview ICS import" })).toBeTruthy();
    expect(screen.getByText(/no data-changing callback/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Acknowledge preview" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("status").textContent).toBe("Preview acknowledged. No data changed; no receipt or effect occurred.");
  });

  it("offers export before destructive profile confirmation", async () => {
    const user = userEvent.setup();
    render(<SourcesPrivacySection rows={buildSourcePrivacyRows(fixtures)} explanation={explanation} />);
    expect(screen.getByRole("button", { name: "Preview data export" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Preview profile deletion" }));
    expect(screen.getByRole("dialog", { name: "Preview profile deletion" })).toBeTruthy();
    expect(screen.getByText(/Export or back up your data first/i)).toBeTruthy();
  });

  it("disables unconfigured live controls with a visible reason", () => {
    render(<SourcesPrivacySection rows={buildSourcePrivacyRows([])} explanation={explanation} />);
    const connect = screen.getByRole("button", { name: "Google Calendar connect unavailable" });
    expect(connect).toHaveProperty("disabled", true);
    expect(screen.getAllByText("Live connector configuration is required.").length).toBeGreaterThan(0);
  });

  it("overrides only configured live sources while preserving deterministic fixtures", () => {
    const live: ConnectorManifest = { schemaVersion: 1, source: "github", mode: "github-app", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], consentRevision: 3, freshness: { ...freshness, state: "fresh" } };
    const rows = buildSourcePrivacyRows(mergeSourceManifests(fixtures, [live]));
    expect(rows.find((row) => row.source === "github")).toMatchObject({ status: "Live", freshness: `fresh; checked ${freshness.fetchedAt}` });
    expect(rows.filter((row) => row.status === "Fixture only")).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toMatch(/"(?:accessToken|refreshToken|clientSecret|ciphertext)":/i);
  });
});
