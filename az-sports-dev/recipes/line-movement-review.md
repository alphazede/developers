# Line Movement Review Recipe

Use this recipe to inspect public movement and prop-edge endpoints.

## Request Template

Ask your MCP host to:

> Pull AlphaZede Sports movement history for the selected game and summarize major line moves, current public edge labels, and any stale or missing data warnings.

## Good Inputs

- Sport code.
- Game identifier from the public games endpoint.
- Optional prop identifier when reviewing one market.

## Guardrails

- Do not infer hidden fields or unpublished formulas.
- Cross-check endpoint availability in [docs/api.md](../docs/api.md).
- Prefer concise public explanations over numeric detail that is not present in the response.
