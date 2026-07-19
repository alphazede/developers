import type { ConnectorManifest, ConnectorSource } from "../../application/connectors";

export type SourceAction = Readonly<{ id: string; label: string; scope: string; enabled: boolean; disabledReason?: string }>;
export type SourcePrivacyRow = Readonly<{
  source: ConnectorSource; name: string; status: "Live" | "Fixture only" | "Local file" | "Not configured";
  access: string; capabilities: readonly string[]; retained: string; limits: string; freshness: string;
  actions: readonly SourceAction[];
}>;
const missing = "Live connector configuration is required.";
const action = (id: string, label: string, scope: string, enabled: boolean, disabledReason = missing): SourceAction => ({ id, label, scope, enabled, ...(enabled ? {} : { disabledReason }) });

export const buildSourcePrivacyRows = (manifests: readonly ConnectorManifest[]): readonly SourcePrivacyRow[] => {
  const current = new Map(manifests.map((item) => [item.source, item]));
  const live = (source: ConnectorSource) => current.get(source)?.freshness.state === "fresh";
  const fresh = (source: ConnectorSource) => current.get(source)?.freshness;
  const freshness = (source: ConnectorSource) => fresh(source) ? `${fresh(source)?.state}; checked ${fresh(source)?.fetchedAt}` : "No active connection";
  return [
    { source: "google-calendar", name: "Google Calendar", status: live("google-calendar") ? "Live" : "Not configured", access: "OAuth; calendar read, with separate confirmed event-write scope", capabilities: ["calendar.read", "calendar.event.write (optional)"], retained: "Normalized calendar commitments and freshness; OAuth token only while connected", limits: "Event creation requires a separate approved effect", freshness: freshness("google-calendar"), actions: live("google-calendar") ? [action("google-sync", "Google Calendar sync", "Read current calendar changes", true), action("google-revoke", "Google Calendar revoke", "Remove the token and dependent Google Calendar data", true)] : [action("google-connect", "Google Calendar connect", "Request the minimum calendar.read scope", false)] },
    { source: "gmail", name: "Selected Gmail message", status: live("gmail") ? "Live" : "Not configured", access: "Normalized payload seam for a separately configured Workspace add-on current-message grant", capabilities: ["gmail.selected-message.read"], retained: "Normalized title and deadline plus message/thread provenance; the selected fragment and raw body are discarded.", limits: "The add-on boundary must verify Google's temporary grant before forwarding. This route does not validate a Google-issued grant; normal Gmail OAuth and broad Gmail scopes are disabled.", freshness: live("gmail") ? freshness("gmail") : "Temporary grant not active", actions: live("gmail") ? [action("gmail-revoke", "Gmail grant revoke", "Forget normalized Gmail data and the temporary grant", true)] : [action("gmail-connect", "Gmail current-message grant", "Request access to only the currently selected message", false, "Open this app from the configured Workspace add-on.")] },
    { source: "github", name: "GitHub", status: live("github") ? "Live" : "Not configured", access: "GitHub App; imported tasks stay read-only", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], retained: "Normalized task fields and connector freshness", limits: "No issue mutation or completion from this view", freshness: freshness("github"), actions: live("github") ? [action("github-sync", "GitHub sync", "Refresh imported task fields", true), action("github-revoke", "GitHub revoke", "Remove GitHub authorization and dependent data", true)] : [action("github-connect", "GitHub connect", "Install the task-reading GitHub App", false)] },
    { source: "linear", name: "Linear", status: live("linear") ? "Live" : "Not configured", access: "OAuth; imported tasks stay read-only", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], retained: "Normalized task fields and connector freshness", limits: "No Linear mutation or completion from this view", freshness: freshness("linear"), actions: live("linear") ? [action("linear-sync", "Linear sync", "Refresh imported task fields", true), action("linear-revoke", "Linear revoke", "Remove Linear authorization and dependent data", true)] : [action("linear-connect", "Linear connect", "Request task-reading OAuth scopes", false)] },
    { source: "ics", name: "ICS file", status: "Local file", access: "Apple-compatible calendar file path; no Apple credentials requested.", capabilities: ["calendar.preview", "calendar.import", "calendar.export"], retained: "Only confirmed normalized calendar items", limits: "Preview is required before import", freshness: "Client-held file; no background sync", actions: [action("ics-import", "ICS import", "Preview and confirm selected calendar-file items", true), action("ics-export", "ICS export", "Create a calendar file from approved local items", true)] },
    { source: "microsoft", name: "Microsoft", status: "Fixture only", access: "Synthetic calendar fixture", capabilities: ["calendar.fixture.read"], retained: "Deterministic normalized fixture commitments", limits: "No live Microsoft account connection", freshness: freshness("microsoft"), actions: [action("microsoft-sync", "Microsoft fixture sync", "Reload deterministic Microsoft fixture data", true), action("microsoft-revoke", "Microsoft fixture revoke", "Remove Microsoft fixture data", true)] },
    { source: "strava", name: "Strava", status: "Fixture only", access: "Synthetic activity fixture", capabilities: ["activity.fixture.read"], retained: "Deterministic activity summaries", limits: "No live Strava account connection", freshness: freshness("strava"), actions: [action("strava-sync", "Strava fixture sync", "Reload deterministic Strava fixture data", true), action("strava-revoke", "Strava fixture revoke", "Remove Strava fixture data", true)] },
    { source: "oura", name: "Oura", status: "Fixture only", access: "Synthetic readiness fixture", capabilities: ["readiness.fixture.read"], retained: "Deterministic readiness summaries", limits: "No live Oura account connection", freshness: freshness("oura"), actions: [action("oura-sync", "Oura fixture sync", "Reload deterministic Oura fixture data", true), action("oura-revoke", "Oura fixture revoke", "Remove Oura fixture data", true)] },
  ];
};

export const syntheticPrivacyManifests = (fetchedAt: string): readonly ConnectorManifest[] => [
  { schemaVersion: 1, source: "microsoft", mode: "fixture", capabilities: ["calendar.fixture.read"], consentRevision: 0, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "strava", mode: "fixture", capabilities: ["activity.fixture.read"], consentRevision: 0, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "oura", mode: "fixture", capabilities: ["readiness.fixture.read"], consentRevision: 0, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
];

export const mergeSourceManifests = (synthetic: readonly ConnectorManifest[], live: readonly ConnectorManifest[]): readonly ConnectorManifest[] => {
  const merged = new Map(synthetic.map((manifest) => [manifest.source, manifest]));
  for (const manifest of live) merged.set(manifest.source, manifest);
  return Object.freeze([...merged.values()].sort((left, right) => left.source.localeCompare(right.source)));
};
