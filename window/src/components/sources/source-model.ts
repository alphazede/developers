import type { ConnectorManifest, ConnectorSource } from "../../application/connectors";

export type SourceAction = Readonly<{ id: string; label: string; scope: string; enabled: boolean; disabledReason?: string }>;
export type SourcePrivacyRow = Readonly<{
  source: ConnectorSource; name: string; status: "Live" | "Stale" | "Revoked" | "Fixture only" | "Local file" | "Not configured";
  access: string; capabilities: readonly string[]; retained: string; limits: string; freshness: string;
  actions: readonly SourceAction[];
}>;
type SourceState = "fresh" | "stale" | "revoked" | "fixture" | "not-configured";

const missing = "Live connector configuration is required.";
const disabledReasons: Record<Exclude<SourceState, "fresh" | "fixture">, string> = {
  stale: "The source is stale; reconnect it before syncing.",
  revoked: "Access was revoked; reconnect the source before syncing.",
  "not-configured": missing,
};
const action = (id: string, label: string, scope: string, enabled: boolean, disabledReason = missing): SourceAction => ({ id, label, scope, enabled, ...(enabled ? {} : { disabledReason }) });
const displayStatus = (source: ConnectorSource, state: SourceState): SourcePrivacyRow["status"] => {
  if (state === "fresh") return "Live";
  if (state === "stale") return "Stale";
  if (state === "revoked") return "Revoked";
  if (state === "fixture") return source === "ics" ? "Local file" : "Fixture only";
  return "Not configured";
};

export const buildSourcePrivacyRows = (manifests: readonly ConnectorManifest[]): readonly SourcePrivacyRow[] => {
  const current = new Map(manifests.map((item) => [item.source, item]));
  const state = (source: ConnectorSource): SourceState => current.get(source)?.freshness.state ?? "not-configured";
  const status = (source: ConnectorSource) => displayStatus(source, state(source));
  const freshness = (source: ConnectorSource) => {
    const value = current.get(source)?.freshness;
    return value ? `${value.state}; checked ${value.fetchedAt}` : "No active connection";
  };
  const operational = (source: ConnectorSource) => ["fresh", "fixture"].includes(state(source));
  const revocable = (source: ConnectorSource) => ["fresh", "stale", "fixture"].includes(state(source));
  const unavailable = (source: ConnectorSource) => disabledReasons[state(source) as keyof typeof disabledReasons] ?? missing;
  const fixtureLabel = (source: ConnectorSource, liveLabel: string) => state(source) === "fixture" ? `${liveLabel} fixture` : liveLabel;
  const connectedActions = (source: ConnectorSource, name: string, syncScope: string, revokeScope: string): readonly SourceAction[] => {
    if (["revoked", "not-configured"].includes(state(source))) return [action(`${source}-connect`, `${name} connect`, `Configure ${name}`, false, unavailable(source))];
    return [
      action(`${source}-sync`, `${fixtureLabel(source, name)} sync`, syncScope, operational(source), unavailable(source)),
      action(`${source}-revoke`, `${fixtureLabel(source, name)} revoke`, revokeScope, revocable(source), unavailable(source)),
    ];
  };
  return [
    { source: "google-calendar", name: "Google Calendar", status: status("google-calendar"), access: "OAuth; calendar read, with separate confirmed event-write scope", capabilities: ["calendar.read", "calendar.event.write (optional)"], retained: "Normalized calendar commitments and freshness; OAuth token only while connected", limits: "Event creation requires a separate approved effect", freshness: freshness("google-calendar"), actions: connectedActions("google-calendar", "Google Calendar", "Read current calendar changes", "Remove the token and dependent Google Calendar data") },
    { source: "gmail", name: "Selected Gmail message", status: status("gmail"), access: "Normalized payload seam for a separately configured Workspace add-on current-message grant", capabilities: ["gmail.selected-message.read"], retained: "Normalized title and deadline plus message/thread provenance; the selected fragment and raw body are discarded.", limits: "The add-on boundary must verify Google's temporary grant before forwarding. This route does not validate a Google-issued grant; normal Gmail OAuth and broad Gmail scopes are disabled.", freshness: freshness("gmail"), actions: state("gmail") === "fixture" ? connectedActions("gmail", "Gmail selection", "Reload deterministic selected-message fixture data", "Remove selected-message fixture data") : revocable("gmail") ? [action("gmail-revoke", "Gmail grant revoke", "Forget normalized Gmail data and the temporary grant", true)] : [action("gmail-connect", "Gmail current-message grant", "Request access to only the currently selected message", false, state("gmail") === "revoked" ? disabledReasons.revoked : "Open this app from the configured Workspace add-on.")] },
    { source: "github", name: "GitHub", status: status("github"), access: "GitHub App; imported tasks stay read-only", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], retained: "Normalized task fields and connector freshness", limits: "No issue mutation or completion from this view", freshness: freshness("github"), actions: connectedActions("github", "GitHub", "Refresh imported task fields", "Remove GitHub authorization and dependent data") },
    { source: "linear", name: "Linear", status: status("linear"), access: "OAuth; imported tasks stay read-only", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], retained: "Normalized task fields and connector freshness", limits: "No Linear mutation or completion from this view", freshness: freshness("linear"), actions: connectedActions("linear", "Linear", "Refresh imported task fields", "Remove Linear authorization and dependent data") },
    { source: "ics", name: "ICS file", status: status("ics"), access: "Apple-compatible calendar file path; no Apple credentials requested.", capabilities: ["calendar.preview", "calendar.import", "calendar.export"], retained: "Only confirmed normalized calendar items", limits: "Preview is required before import", freshness: freshness("ics"), actions: operational("ics") ? [action("ics-import", "ICS import", "Preview and confirm selected calendar-file items", true), action("ics-export", "ICS export", "Create a calendar file from approved local items", true)] : [action("ics-import", "ICS import", "Preview and confirm selected calendar-file items", false, unavailable("ics"))] },
    { source: "microsoft", name: "Microsoft", status: status("microsoft"), access: "Synthetic calendar fixture", capabilities: ["calendar.fixture.read"], retained: "Deterministic normalized fixture commitments", limits: "No live Microsoft account connection", freshness: freshness("microsoft"), actions: connectedActions("microsoft", "Microsoft", "Reload deterministic Microsoft fixture data", "Remove Microsoft fixture data") },
    { source: "strava", name: "Strava", status: status("strava"), access: "Synthetic activity fixture", capabilities: ["activity.fixture.read"], retained: "Deterministic activity summaries", limits: "No live Strava account connection", freshness: freshness("strava"), actions: connectedActions("strava", "Strava", "Reload deterministic Strava fixture data", "Remove Strava fixture data") },
    { source: "oura", name: "Oura", status: status("oura"), access: "Synthetic readiness fixture", capabilities: ["readiness.fixture.read"], retained: "Deterministic readiness summaries", limits: "No live Oura account connection", freshness: freshness("oura"), actions: connectedActions("oura", "Oura", "Reload deterministic Oura fixture data", "Remove Oura fixture data") },
  ];
};

export const syntheticPrivacyManifests = (fetchedAt: string): readonly ConnectorManifest[] => [
  { schemaVersion: 1, source: "google-calendar", mode: "oauth", capabilities: ["calendar.read"], consentRevision: 1, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "gmail", mode: "gmail-addon", capabilities: ["gmail.selected-message.read"], consentRevision: 1, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "github", mode: "github-app", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], consentRevision: 1, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "linear", mode: "oauth", capabilities: ["task.connect", "task.read", "task.sync", "task.revoke"], consentRevision: 1, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "ics", mode: "import", capabilities: ["calendar.preview", "calendar.import", "calendar.export"], consentRevision: 1, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "microsoft", mode: "fixture", capabilities: ["calendar.fixture.read"], consentRevision: 0, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "strava", mode: "fixture", capabilities: ["activity.fixture.read"], consentRevision: 0, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
  { schemaVersion: 1, source: "oura", mode: "fixture", capabilities: ["readiness.fixture.read"], consentRevision: 0, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } },
];

export const mergeSourceManifests = (synthetic: readonly ConnectorManifest[], live: readonly ConnectorManifest[]): readonly ConnectorManifest[] => {
  const merged = new Map(synthetic.map((manifest) => [manifest.source, manifest]));
  for (const manifest of live) merged.set(manifest.source, manifest);
  return Object.freeze([...merged.values()].sort((left, right) => left.source.localeCompare(right.source)));
};
