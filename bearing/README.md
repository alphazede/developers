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
4. Enter a work request and select **Embark**. Bearing records the request, invokes the verified route, and begins the real staged journey. Agent questions and owner answers are also recorded in the durable run ledger.

## Real browser journey

The main browser flow uses the selected, readiness-verified harness; it is not a canned workflow projection:

1. **Set Bearings** starts the plan and returns validated plan artifacts.
2. **Gather Supplies** asks one adaptive owner question at a time until the selected agent can proceed.
3. **Map the Route** produces the design, SEIT, and self-contained review baseline, then Bearing drafts `implementation.md`.
4. The owner chooses **Explorer** or **Expedition** plus Surveyor review cadence. Explorer uses fewer sessions; Expedition enables bounded subagents for parallel lanes.
5. The selected harness executes the approved route. Bearing then invokes native review where supported, with a read-only Surveyor fallback, and presents cumulative validated artifacts. Generated HTML evidence opens through contained, authenticated links.

While a real agent call is pending, Bearing shows the stable public phase name, an indeterminate moving trail, honest helper text, elapsed time, and only artifacts already validated by completed results. It does not invent percentages, activity details, or an ETA. Failures remain retryable and do not become success claims.

## Explorer and Expedition

- **Explorer** uses one Explorer to coordinate bounded Crewmates. It is the lower-agent, lower-manager-token choice for a small set of related work items, but one Explorer carries the coordination fan-out.
- **Expedition** adds a Navigator and multiple bounded Explorer groups. It costs more coordination and tokens, but fits multi-phase work whose lanes benefit from independent management.

Real skill-driven planning and execution can use substantial tokens, especially with Explorer or Expedition. Bearing displays a persistent warning rather than imposing a default hard token ceiling. If you use a subscription plan, consider a higher tier, choose reasoning deliberately, and use [Caveman](https://github.com/juliusbrussee/caveman) to reduce planning context. An explicit `--budget` remains available when an owner wants a hard per-call boundary.

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
| `--budget` | Optional positive safe-integer per-call token ceiling. No ceiling is imposed by default. |

Pass values as `--flag value` or `--flag=value`. Duplicate, unknown, credential-shaped, per-role, conflicting tool, and out-of-range values are rejected. Never put keys, tokens, passwords, or other credentials in a flag.

## Deterministic tutorial and showcase fixtures

The token-free tutorial and included fictional B2B showcases are separate from the real browser journey above. They are deterministic, provider-disabled fixtures for orientation and QA. Their authenticated JSON and offline HTML report endpoints never execute external work and are not evidence that a selected harness completed a real request.

1. **Engineering Import** models a feature/import flow with an owner role gate, input validation, dry run, duplicate handling, atomic customer/audit publication, and independent Survey.
2. **Launch Readiness** turns repository facts into a marketing brief and infographic-input evidence. Survey blocks an unsupported 40% promise; an owner-approved correction removes it, then an independent Resurvey passes the corrected brief.
3. **Due Diligence** answers supported product questions from repository evidence while leaving security certification and retention answers blocked with named owners.

Each demo exposes decision stops, expected artifacts, outcome classes, Survey/Resurvey history, and an offline evidence report that can be opened or saved from the browser.

## State, recovery, export, and deletion

Bearing stores a workspace manifest plus per-run hash-linked JSONL ledgers and snapshots beneath the selected repository's `.bearing/` directory. Choosing the same repository on a later launch resumes it. The ledger is authoritative; a missing or stale snapshot can be rebuilt from valid events. Corrupt, truncated, future-schema, sequence-invalid, or hash-invalid state blocks writable resume instead of being silently reset.

The real journey presents contained authenticated links for validated generated HTML artifacts; showcase reports remain self-contained HTML fixtures. There is not yet an in-app full-state export or delete control. To preserve all local state, stop Bearing and copy the repository's `.bearing/` directory to an owner-controlled backup. To retire it recoverably, stop Bearing, make that backup, and rename `.bearing/` to a repository-specific quarantine name; permanent deletion remains an explicit repository-owner action. Provider credentials are never part of `.bearing/`.

## Evaluation

Bearing's evaluator uses matched control/treatment arms, exact route identity, three trials per case/arm/route, retained failures, and route-level verdicts that fail closed on missing, duplicate, drifting, or regressing cells.

The current native characterization command creates and cleans **336 synthetic local cells** across 14 positive/negative cases, two arms, four route descriptors, and three trials. Its passing verdict validates matrix and aggregation machinery only: it is not provider evidence and cannot authorize skill changes. The separate pinned eight-task SkillsBench v1.1 ingestion path requires a scanned external checkout and complete attested provider results; that panel has not been executed or verified for this submission. A real four-route evaluation is also pending.

## Provenance of the work

AlphaZede's underlying workflow skills, planning conventions, and bounded-agent engine concepts pre-date this hackathon submission. The Bearing submission-period work is the new local browser/HTTP control-room package, repository-local durable state and authority surfaces, selected-harness journey bridge, adaptive owner Q&A, Explorer/Expedition execution UI, validated artifact serving, fictional showcase fixtures, evidence reports, evaluation harness, and public package/submission material. The package does not represent the pre-existing workflow engine itself as newly created work.

## Platform assumptions and limitations

- Node.js 22+ and a writable local filesystem are required. `package.json` pins pnpm 10.33.0.
- Browser opening uses `open` on macOS, `cmd /c start` on Windows, and `xdg-open` on other platforms; use `--no-open` when that integration is unavailable. Cross-platform packaging is implemented but not certified here.
- The server is single-user and loopback-only. There are no hosted accounts, remote telemetry, production deployment, support SLA, or multi-user authorization boundary.
- The native UI is intentionally small. The real staged journey launches the selected harness, but it does not provide a general-purpose terminal, arbitrary workflow editor, full-state export, or delete controls.
- Tutorial and showcase providers are intentionally disabled; they remain deterministic fixtures. Real journey readiness and effective isolation depend on the selected local harness and its attestation, and may be unavailable.
- SkillsBench execution, hosted CI, package publication, deployment, and owner-recorded video evidence are unverified or pending.
- Optional RAG-assisted context, external config discovery, OAuth/setup flows, alias migrations, and skill lifecycle changes are not enabled by this package's browser flow.

## License

MIT. See [LICENSE](LICENSE).
