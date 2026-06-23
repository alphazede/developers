# Security Policy

AlphaZede Sports accepts vulnerability reports for the public developer repository, `@alphadezede/mcp-server`, and `@alphadezede/api-client`.

## Supported Versions

| Surface | Supported version |
|---|---|
| Public developer repository | Current `main` branch after publication |
| `@alphadezede/mcp-server` | Latest published package version |
| `@alphadezede/api-client` | Latest published package version |

## Reporting A Vulnerability

Report vulnerabilities through https://alphazedesports.com/contact with topic Security.

Include:

- Affected package, file, endpoint, or MCP host.
- Reproduction steps using public docs or public package versions.
- Expected and actual behavior.
- Any public trace identifier returned by the API.

Do not include live API keys, account credentials, private customer data, or exploit payloads that are not needed to reproduce the issue. Rotate any exposed key before sharing reproduction details.

## Public Boundary

The public repository is for audited developer assets only. Do not open issues that contain credentials, unreleased implementation detail, or private customer data.
