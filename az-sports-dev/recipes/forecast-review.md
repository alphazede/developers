# Forecast Review Recipe

Use this recipe after configuring the MCP server with `AZS_API_KEY`.

## Request Template

Ask your MCP host to:

> Review today's NBA forecasts from AlphaZede Sports. Show the game, market, confidence label, and one concise reason for each public forecast.

## Good Inputs

- Sport code, such as `NBA`, `NFL`, or `MLB`.
- Date in `YYYY-MM-DD` format.
- A requested output format: table, bullet list, or JSON summary.

## Guardrails

- Do not include API keys in the request.
- Verify that returned fields exist in [api/openapi.json](../api/openapi.json).
- Treat missing games or empty arrays as valid API responses, not tool failures.
