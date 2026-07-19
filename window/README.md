# Capacity scheduling prototype

An unpublished, name-unfrozen prototype for planning work against personal capacity. The default experience uses deterministic synthetic data and requires no credentials.

## Quick start

Use Node.js 24, pnpm 10.14.0, and an installed Chromium-compatible browser.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

`pnpm judge` builds and runs the fixed synthetic browser story on loopback with outbound network access denied. `pnpm verify` runs the local CI contract from the repository checkout and its reviewed lockfile: frozen install, typecheck, lint, tests, production dependency audit, public-package inspection, judge flow, and startup smoke. The judge and application checks are credential-free and provider-offline; install and audit may contact the configured package registry. The private dry-run tarball is inspected evidence only; it is not an authorized publication channel.

## First-run connector activation

Live connectors are local-only and disabled by default. Before starting the server, set `CONNECTORS_ENABLED=1`, `APP_ORIGIN=http://127.0.0.1:3000`, distinct server-only `APP_SESSION_SECRET` and `APP_CSRF_SECRET` values, and absolute `CONNECTOR_STATE_PATH` and `APP_DATA_KEY_PATH` paths. Keep those values out of source, shell history, fixtures, logs, and browser code. Set `COMMAND_ID`, `IDEMPOTENCY_KEY`, and `PROFILE_ID` to fresh bounded values; the command and profile identifiers must be UUIDs.

Initialize the absent local store exactly once through its authenticated route:

```sh
curl --fail-with-body --request POST \
  --url http://127.0.0.1:3000/api/v1/connectors/bootstrap \
  --header "Cookie: sid=${APP_SESSION_SECRET}" \
  --header "Origin: ${APP_ORIGIN}" \
  --header "X-CSRF-Token: ${APP_CSRF_SECRET}" \
  --header "X-Expected-Revision: 0" \
  --header "X-Command-Id: ${COMMAND_ID}" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --header "X-Bootstrap-Confirm: initialize-absent-store" \
  --header "Content-Type: application/json" \
  --data "{\"profileId\":\"${PROFILE_ID}\",\"timeZone\":\"America/Chicago\"}"
```

Success is `201` with schema version 1, revision 0, and `initialized: true`. Disabled configuration returns `503`; authentication fails with `401` before filesystem or provider work; malformed or oversized input returns `400` or `413`. An existing, corrupt, or unsafe store returns `409 BOOTSTRAP_REFUSED` and is never replaced. Bootstrap creates no provider connection and grants no capability: each provider still activates only through its reviewed OAuth or app route and consent boundary.

## Capability boundary

| Source | Supported capability | Mutation boundary |
|---|---|---|
| Local synthetic profile | Capacity, schedule, proposals, Focus Gate, and privacy previews | Local changes still require the applicable gate and confirmation |
| Google Calendar | Optional bounded read; separately confirmed event write | No event write without explicit effect approval |
| Selected Gmail message | Separately configured Workspace add-on normalized-payload seam | The local scope header records the expected capability but does not prove a Google grant; normal Gmail OAuth and broad mailbox reads are disabled |
| GitHub and Linear | Read-only task metadata | No create, update, completion, comment, or deletion |
| ICS calendar file | Previewed local import and approved export; Apple-compatible | No account credential or background synchronization |
| Microsoft, Strava, and Oura | Deterministic fixture data only | No live connection claim |

The live connector code stays disabled until server-only configuration supplies the reviewed provider identity, exact loopback redirect, encrypted token store, and least-privilege consent. Never place credentials in browser code, fixtures, package metadata, or logs.

Selected Gmail ingestion depends on the external Workspace add-on enforcing its own current-message grant before sending a normalized payload. This local application neither obtains nor infers that Google grant from a request header.

## Privacy and accessibility

Capacity and demanding-meeting signals are transparent personal heuristics, not medical advice, causal claims, or labels for people. Unknown and stale evidence remains visible. Imported work stays immutable, explanations cannot approve actions, and export, revoke, pattern-forgetting, and profile-deletion controls show their local and remote limits before confirmation.

The primary flow uses native buttons with keyboard equivalents and live status messages. Charts retain complete text and table alternatives; narrow layouts, 200% zoom, and reduced motion are release checks.

## License

The distributed source and bundled synthetic fixtures are provided under [Apache-2.0](LICENSE). The dependency graph and exact packed-file set are checked locally before any release decision; this repository does not authorize publishing or deployment.
