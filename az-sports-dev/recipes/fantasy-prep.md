# Fantasy Prep Recipe

Use this recipe for public fantasy-football and fantasy-basketball endpoints.

## Request Template

Ask your MCP host to:

> Use AlphaZede Sports fantasy tools to summarize waiver, start-sit, and projection signals for my league context. Return a table with player, team, position, public signal, and next action.

## Good Inputs

- Sport code and week or date.
- League identifier if your account has connected league access.
- Position or roster slot constraints.

## Guardrails

- Keep league credentials outside assistant messages.
- Use [docs/authentication.md](../docs/authentication.md) for key handling.
- Use only fields returned by the public API contract.
