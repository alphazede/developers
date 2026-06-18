# Authentication

AlphaZede Sports public API integrations authenticate with managed API keys sent as bearer tokens.

## Bearer Header

Send the key on every API request:

```http
Authorization: Bearer <AZS_API_KEY>
Accept: application/json
```

Use the `AZS_API_KEY` environment variable in local tooling and deployment secret stores. Do not place live keys in committed files, public examples, issue text, or assistant messages.

## REST Example

```ts
const response = await fetch("https://api.alphazedesports.com/api/v1/health", {
  headers: {
    Authorization: `Bearer ${process.env.AZS_API_KEY}`,
    Accept: "application/json",
  },
});

if (!response.ok) {
  throw new Error(`AlphaZede Sports API returned ${response.status}`);
}
```

## MCP Example

Use [`.mcp.example.json`](../.mcp.example.json) or [examples/mcp-host-config.json](../examples/mcp-host-config.json) and provide `AZS_API_KEY` through your MCP host configuration.

## Key Hygiene

- Use one key per environment or integration.
- Rotate exposed keys before reconnecting clients.
- Keep keys out of source control and package tarballs.
- Use [SECURITY.md](../SECURITY.md) for vulnerability reports.

See [Rate Limits](rate-limits.md) for quota and retry behavior.
