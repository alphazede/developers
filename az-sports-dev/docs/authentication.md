# Authentication

AlphaZede Sports public API integrations authenticate with managed API keys sent as bearer tokens.

## Bearer Header

Send the key on every API request:

```http
Authorization: Bearer <API_KEY>
Accept: application/json
```

Examples use a generic `API_KEY` placeholder. Store the real key in your deployment secret manager or MCP host secret storage. Do not place live keys in committed files, public examples, issue text, or assistant messages. See [Public Credential Handling](public-secret-handling.md) for the public documentation template.

## REST Example

```ts
const apiKey = process.env.API_KEY;

if (!apiKey) {
  throw new Error("Set API_KEY before calling the AlphaZede Sports API.");
}

const response = await fetch("https://api.alphazedesports.com/api/v1/health", {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  },
});

if (!response.ok) {
  throw new Error(`AlphaZede Sports API returned ${response.status}`);
}
```

## MCP Example

Use [`.mcp.example.json`](../.mcp.example.json) or [examples/mcp-host-config.json](../examples/mcp-host-config.json) and provide the API key through your MCP host configuration or secret store.

## Key Hygiene

- Use one key per environment or integration.
- Rotate exposed keys before reconnecting clients.
- Keep keys out of source control and package tarballs.
- Use [SECURITY.md](../SECURITY.md) for vulnerability reports.

See [Rate Limits](rate-limits.md) for quota and retry behavior.
