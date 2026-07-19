---
type: public-guide
title: Bearing
okf_status: active
tags:
  - developer
  - public
---

# Bearing

Bearing is a local browser control room for planning agent work, recording owner decisions, and presenting evidence about what was completed, corrected, blocked, or left unperformed. It is a Work & Productivity hackathon project for founders and small teams that need bounded asynchronous work without surrendering approval or review authority.

This is a `0.1.0` pre-release. It is a local demonstration package, not a hosted service, published npm package, deployed product, or claim that any provider route is ready on your machine.

## Install, build, and start locally

Bearing requires Node.js 22 or newer. From this package directory:

```sh
corepack pnpm install --frozen-lockfile
pnpm build
node dist/cli.js start
```

`start` binds an ephemeral port on `127.0.0.1`, prints the local URL, and opens the default browser. To print the URL without opening a browser:

```sh
node dist/cli.js start --no-open
```

Keep that terminal running while using the control room. The URL contains a one-time capability in its fragment; do not share it.

## First launch

1. Choose one absolute path to a writable local repository. Bearing initializes or resumes `.bearing/` inside that repository; credentials remain outside it.
2. Choose one detected provider route, model, and reasoning level. The model and reasoning selection is shared across all four role profiles for the run; there are no per-role model choices.
3. Complete the readiness check. Detection alone is not verification, and an unavailable selection is blocked rather than silently substituted.
4. Enter a work request and review the recommended execution mode, estimated agent count, and token warning. Approval or override records the owner decision but does not currently launch work from the browser.

## Explorer and Expedition

- **Explorer** uses one Explorer to coordinate bounded Crewmates. It is the lower-agent, lower-manager-token choice for a small set of related work items, but one Explorer carries the coordination fan-out.
- **Expedition** adds a Navigator and multiple bounded Explorer groups. It costs more coordination and tokens, but fits multi-phase work whose lanes benefit from independent management.

Bearing estimates agents and tokens before approval. Treat the estimate as a warning, not a quote. As provider-neutral product guidance, start planning with a `low` reasoning profile and bounded implementation with `medium`; increase reasoning only when the task and evidence justify the extra cost. No specific provider is required by that guidance.

## Roles and authority

- **Navigator** coordinates an Expedition and does not perform independent research.
- **Explorer** manages a bounded group of Crewmates and can inspect context without execution authority beyond its profile.
- **Crewmate** performs a bounded implementation task within the allowed tools, workspace, and limits.
- **Surveyor** independently reviews evidence, has no execution ancestry, and cannot certify its own execution.

The local Node server—not the browser—owns durable workflow state, command validation, approval checks, adapter invocation, and evidence projection. The browser never receives provider credentials. Recommendations never authorize execution; material actions require durable owner evidence. Fallback is disabled by default, unsupported authority combinations fail closed, and isolation is reported as attested, local, off, or blocked rather than assumed.

## Safe start flags

The CLI accepts only the following bounded overrides:

| Flag | Accepted value or effect |
|---|---|
| `--no-open` | Do not open a browser. |
| `--agent` | Shared agent reference. |
| `--provider`, `--model` | Shared route selection; never per-role. |
| `--reasoning` | `low`, `medium`, `high`, or `xhigh`. |
| `--decision-depth` | `focused`, `standard`, or `deep`. |
| `--tools`, `--exclude-tools` | Bounded comma-separated tool names. |
| `--no-session` | Disable provider session persistence for the run. |
| `--offline` | Remove network authority for the run. |
| `--timeout` | Positive milliseconds, at most `300000`. |
| `--max-turns` | Positive count, at most `20`. |
| `--budget` | Positive token budget, at most `100000`. |

Pass values as `--flag value` or `--flag=value`. Duplicate, unknown, credential-shaped, per-role, conflicting tool, and out-of-range values are rejected. Never put keys, tokens, passwords, or other credentials in a flag.

## Deterministic demo workflows

The included fictional B2B fixture provides three provider-disabled demonstrations. Selecting one displays a projection and does not execute external work.

1. **Engineering Import** models a feature/import flow with an owner role gate, input validation, dry run, duplicate handling, atomic customer/audit publication, and independent Survey.
2. **Launch Readiness** turns repository facts into a marketing brief and infographic-input evidence. Survey blocks an unsupported 40% promise; an owner-approved correction removes it, then an independent Resurvey passes the corrected brief.
3. **Due Diligence** answers supported product questions from repository evidence while leaving security certification and retention answers blocked with named owners.

Each demo exposes decision stops, expected artifacts, outcome classes, Survey/Resurvey history, and an offline evidence report that can be opened or saved from the browser.

## State, recovery, export, and deletion

Bearing stores a workspace manifest plus per-run hash-linked JSONL ledgers and snapshots beneath the selected repository's `.bearing/` directory. Choosing the same repository on a later launch resumes it. The ledger is authoritative; a missing or stale snapshot can be rebuilt from valid events. Corrupt, truncated, future-schema, sequence-invalid, or hash-invalid state blocks writable resume instead of being silently reset.

The current export surface saves a self-contained HTML evidence report for a demo workflow. There is not yet an in-app full-state export or delete control. To preserve all local state, stop Bearing and copy the repository's `.bearing/` directory to an owner-controlled backup. To retire it recoverably, stop Bearing, make that backup, and rename `.bearing/` to a repository-specific quarantine name; permanent deletion remains an explicit repository-owner action. Provider credentials are never part of `.bearing/`.

## Evaluation

Bearing's evaluator uses matched control/treatment arms, exact route identity, three trials per case/arm/route, retained failures, and route-level verdicts that fail closed on missing, duplicate, drifting, or regressing cells.

The current native characterization command creates and cleans **336 synthetic local cells** across 14 positive/negative cases, two arms, four route descriptors, and three trials. Its passing verdict validates matrix and aggregation machinery only: it is not provider evidence and cannot authorize skill changes. The separate pinned eight-task SkillsBench v1.1 ingestion path requires a scanned external checkout and complete attested provider results; that panel has not been executed or verified for this submission. A real four-route evaluation is also pending.

## Provenance of the work

AlphaZede's underlying workflow skills, planning conventions, and bounded-agent engine concepts pre-date this hackathon submission. The Bearing submission-period work is the new local browser/HTTP control-room package, repository-local durable state and authority surfaces, provider adapter boundary, Explorer/Expedition recommendation UI, fictional three-workflow showcase, evidence reports, evaluation harness, and public package/submission material. The package does not represent the pre-existing workflow engine itself as newly created work.

## Platform assumptions and limitations

- Node.js 22+ and a writable local filesystem are required. `package.json` pins pnpm 10.33.0.
- Browser opening uses `open` on macOS, `cmd /c start` on Windows, and `xdg-open` on other platforms; use `--no-open` when that integration is unavailable. Cross-platform packaging is implemented but not certified here.
- The server is single-user and loopback-only. There are no hosted accounts, remote telemetry, production deployment, support SLA, or multi-user authorization boundary.
- The native UI is intentionally small. Approval currently records a recommendation; it does not launch the demo workflow or offer general run execution, repair, full-state export, or delete controls.
- Demo providers are disabled. Built-in route descriptors and process adapters exist, but no route/provider readiness is claimed. Isolation depends on active-adapter attestation and may be unavailable.
- SkillsBench execution, hosted CI, package publication, deployment, and owner-recorded video evidence are unverified or pending.
- Optional RAG-assisted context, external config discovery, OAuth/setup flows, alias migrations, and skill lifecycle changes are not enabled by this package's browser flow.

## License

MIT. See [LICENSE](LICENSE).
