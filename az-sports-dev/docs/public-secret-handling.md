# Public Credential Handling Guidance

Use this guidance when adding public docs, examples, package READMEs, agent instructions, or MCP host configuration snippets.

## Agent Instruction Template

```md
## Credential Handling

- Use MCP host secret storage or deployment-managed environment variables for credentials.
- Do not tell agents to use a company-specific API-key variable unless the runtime contract requires that exact name.
- Never place API keys, bearer tokens, secret values, or URLs containing credentials in committed files, code comments, issue text, public examples, or user-visible messages.
- If a credential appears exposed, tell the user to rotate it before continuing with live calls.
```

## Public Example Rules

- Use `<API_KEY>` in HTTP header examples.
- Use generic placeholders such as `API_KEY` in copyable local examples.
- Prefer login flows, keyring-backed storage, or MCP host secret storage over long-lived environment variables.
- If a package truly requires a specific environment variable, document it only in the package technical reference and keep agent-facing guidance generic.
- Never include a real key value, filled-in `.env` entry, URL containing credentials, or screenshot of secret values in public material.

## Review Checklist

- No committed live credentials or URLs containing credentials.
- No assistant-facing instruction tells agents to inspect, print, or request a named secret value.
- No public example logs full request headers when they include authorization.
- Existing compatibility variables are clearly marked as compatibility details, not the preferred public setup path.
- Reports of exposed credentials direct users to rotate before retrying live calls.
