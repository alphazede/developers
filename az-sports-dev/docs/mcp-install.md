# MCP Install

The AlphaZede Sports MCP server exposes public sports analytics tools to MCP-compatible hosts. Install the npm package, authenticate with `azs-mcp-server login` or host-managed secret configuration, and run the server with `serve`.

## Quickstart

```bash
npm install -g @alphadezede/mcp-server
azs-mcp-server serve
```

For hosts that launch packages directly, use [`.mcp.example.json`](../.mcp.example.json) or [the MCP host config example](../examples/mcp-host-config.json).

## Example Host Configuration

```json
{
  "mcpServers": {
    "alphazede-sports": {
      "command": "npx",
      "args": [
        "-y",
        "@alphadezede/mcp-server",
        "serve"
      ],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

## Supported Host Metadata

| Host | Metadata id |
|---|---|
| Claude Desktop | `claude-desktop` |
| Claude Code | `claude-code` |
| Cursor | `cursor` |
| Cline | `cline` |
| Codex CLI | `codex-cli` |
| Gemini CLI | `gemini-cli` |
| ChatGPT Desktop | `chatgpt-desktop` |
| Zed | `zed` |
| Continue | `continue` |
| Windsurf | `windsurf` |
| Open Interpreter | `open-interpreter` |

The package also ships `packages/mcp-server/server.json` for host directories and marketplace reviewers.

## Tool Metadata

The public server metadata lists 13 tool names. Use the MCP host UI or client logs to inspect tool schemas after connecting.

## Security Notes

- Prefer `azs-mcp-server login` or host-managed secret storage for credentials.
- Use generic local placeholders such as `API_KEY` in examples; keep real variable names and values out of assistant messages.
- Do not paste credentials into assistant messages.
- Revoke and rotate any exposed credential before reconnecting the host.
- Use [SECURITY.md](../SECURITY.md) for vulnerability reporting.
