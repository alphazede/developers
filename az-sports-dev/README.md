# AlphaZede Sports Developers

Public developer repository for AlphaZede Sports API, MCP server, and TypeScript API client integrations.

This repository contains reviewed public developer assets: OpenAPI contracts, package source, install docs, examples, and agent-readable guidance. It is structured for GitHub readers, search crawlers, MCP hosts, and coding agents that need a clear public integration surface.

Canonical repository: https://github.com/alphazede/developers/tree/main/az-sports-dev

## Quickstart

```bash
pnpm install
pnpm -r build
pnpm -r test
```

API quickstart:

See [examples/api-quickstart.ts](examples/api-quickstart.ts).

MCP quickstart:

```bash
npm install -g @alphadezede/mcp-server
azs-mcp-server serve
```

## Repository Map

| Path | Purpose |
|---|---|
| [api/openapi.json](api/openapi.json) | OpenAPI 3.1 JSON contract. |
| [api/openapi.yaml](api/openapi.yaml) | OpenAPI 3.1 YAML contract derived from JSON. |
| [packages/api-client](packages/api-client/README.md) | Public TypeScript API client. |
| [packages/mcp-server](packages/mcp-server/README.md) | Public MCP server package and runtime source. |
| [docs/authentication.md](docs/authentication.md) | API key and bearer-auth guidance. |
| [docs/public-secret-handling.md](docs/public-secret-handling.md) | Public credential-handling guidance for docs and agent instructions. |
| [docs/rate-limits.md](docs/rate-limits.md) | Published request budgets and retry behavior. |
| [docs/api.md](docs/api.md) | Human-readable API overview. |
| [docs/mcp-install.md](docs/mcp-install.md) | MCP host setup. |
| [examples](examples/api-quickstart.ts) | Copyable REST, SDK, and MCP examples. |
| [recipes](recipes/forecast-review.md) | Customer-facing usage recipes. |
| [agents.txt](agents.txt) | Coding-agent consumption index. |
| [llms.txt](llms.txt) | Machine-readable repository index. |

## Agent Files

The public agent guidance is intentionally limited to supported entry points:

- [AGENTS.md](AGENTS.md)
- [CLAUDE.md](CLAUDE.md)
- [.cursor/rules/azs-public-developer.mdc](.cursor/rules/azs-public-developer.mdc)

## Safety And Security

- Use MCP host secret storage or deployment-managed environment variables for credentials.
- Do not commit credentials, local logs, package tarballs, `node_modules`, or build output.
- Report vulnerabilities through [SECURITY.md](SECURITY.md).
- Use only endpoints and package scripts represented in this repository.

## License

Apache-2.0. See [LICENSE](LICENSE).
