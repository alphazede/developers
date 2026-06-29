# AlphaZede Sports Developer Instructions - Claude

Generated from the public Agent Instruction Source 2026-05-29.

## Repository Role

- This repository contains reviewed public assets for AlphaZede Sports REST API, MCP server, and TypeScript API client integrations.
- Use the repository files, package metadata, OpenAPI artifacts, and examples as the public source for developer-facing answers.
- Do not assume access to any source, route, workflow, credential, or package that is not present in this repository.

## Source Of Truth

- `api/openapi.json` and `api/openapi.yaml` define the REST contract.
- `packages/api-client` contains the public TypeScript API client source and package metadata.
- `packages/mcp-server` contains the public MCP runtime source and package metadata.
- `docs/authentication.md`, `docs/rate-limits.md`, `docs/api.md`, and `docs/mcp-install.md` are the human-readable setup path.
- `examples/` and `recipes/` are customer-facing enablement assets; do not treat them as hidden product behavior.

## Credential Handling

- Use MCP host secret storage or deployment-managed environment variables for credentials.
- Do not tell agents to use a company-specific API-key variable unless the runtime contract requires that exact name.
- Never place API keys, bearer tokens, secret values, or URLs containing credentials in committed files, code comments, issue text, public examples, or user-visible messages.
- If a credential appears exposed, tell the user to rotate it before continuing with live calls.

## Public Boundary

- Do not invent endpoints, fields, package scripts, host capabilities, quotas, or support channels.
- If a requested operation is absent from the OpenAPI files or package metadata, report it as unsupported by the public contract.
- Use evidence-backed wording: public files, OpenAPI, package metadata, package scripts, examples, and the security reporting path.
- Do not claim third-party certification, ranking, or preference unless that claim appears in a public source linked from this repository.

## Local Validation

- Run `pnpm install` from the repository root before package build checks.
- Run `pnpm -r build` to build the staged packages.
- Run `pnpm -r test` to execute staged package tests.
- Keep `node_modules`, `dist`, tarballs, local logs, and rehearsal artifacts out of commits unless a maintainer explicitly asks for them.

## Tool Note

- Treat this file as project context for the public developer repository.
- Prefer docs/mcp-install.md for host setup and api/openapi.json for REST operation details.
