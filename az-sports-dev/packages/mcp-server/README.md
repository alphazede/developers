# AlphaZede Sports MCP Server

## Overview

The AlphaZede Sports MCP Server exposes the AlphaZede Sports API through the
Model Context Protocol (MCP). It is designed as an operator-installed gateway:
the MCP client talks to `azs-mcp-server`, and the server forwards authenticated,
identity-bound requests to the upstream API.

The server exposes 13 tools:

- `find_game_markets`
- `analyze_parlay`
- `price_player_prop`
- `explain_edge`
- `get_daily_picks`
- `get_futures`
- `get_alerts`
- `get_ml_projection`
- `get_arb_opportunities`
- `get_dfs_lineups`
- `get_forecasts`
- `get_fantasy_projections`
- `get_fantasy_workspace`

Supported clients include MCP-compatible desktop apps, CLI hosts,
assistant-action surfaces, developer tools, and the AlphaZede browser extension.

## Quick Start

Install dependencies and build the package from the repo root:

```bash
pnpm install
pnpm --filter @azs/mcp-server build
```

During local development, link the binary globally from this package directory:

```bash
cd packages/mcp-server
npm link
# or
pnpm link --global
```

Confirm the binary is available:

```bash
azs-mcp-server help
```

## Login

Authenticate before starting the MCP server:

```bash
azs-mcp-server login
```

The login command opens a browser, starts a temporary loopback callback listener,
performs OAuth code flow with PKCE S256, and stores the resulting token under
`~/.config/alphazede-sports/`.

Use a client-specific registration when needed:

```bash
azs-mcp-server login --client=azs-desktop-mcp
```

Accepted first-party client IDs are assigned per supported integration surface.

If a browser cannot be opened automatically, run:

```bash
azs-mcp-server login --print-auth-url
```

<!-- install:begin -->

## Compatibility

The MCP server is host-mediated, not model-mediated — your choice of LLM is a
host-level configuration. The server passes tool calls to the host's MCP runtime;
the host then routes through whatever model you've configured.

Per-host install snippets are below.

### Claude Desktop

Config path:
- macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
- Windows: %APPDATA%\Claude\claude_desktop_config.json
- Linux: ~/.config/Claude/claude_desktop_config.json

```json
{
  "mcpServers": {
    "alphazede-sports": {
      "command": "azs-mcp-server",
      "args": ["serve"]
    }
  }
}
```

> Restart the app after saving the config file.

### Claude Code

Config path: Project scope (.claude.json) or user scope (~/.claude.json).

```bash
claude mcp add alphazede-sports azs-mcp-server -- serve
```

> Use --scope user before the server name to add at user scope: claude mcp add --scope user alphazede-sports azs-mcp-server -- serve

### Cursor

Config path:
- Project: .cursor/mcp.json
- Global: ~/.cursor/mcp.json

```json
{
  "mcpServers": {
    "alphazede-sports": {
      "command": "azs-mcp-server",
      "args": ["serve"]
    }
  }
}
```

> Create the file if it does not exist. Project-scoped config takes precedence.

### Cline

Config path: VS Code extension storage (accessible via Cline sidebar → MCP Servers → Edit MCP Settings).

```json
{
  "alphazede-sports": {
    "command": "azs-mcp-server",
    "args": ["serve"]
  }
}
```

> Open the Cline extension sidebar, click "MCP Servers", then "Edit MCP Settings" to open the JSON config.

### Codex CLI

Config path: ~/.codex/config.toml (TOML format) or via CLI command.

```bash
codex mcp add alphazede-sports -- azs-mcp-server serve
```

> Or add manually to ~/.codex/config.toml under [mcp_servers.alphazede-sports] in TOML format.

### Gemini CLI

Config path:
- User scope: ~/.gemini/settings.json
- Project scope: .gemini/settings.json (in your project root)

```json
{
  "mcpServers": {
    "alphazede-sports": {
      "command": "azs-mcp-server",
      "args": ["serve"]
    }
  }
}
```

> Use --scope user to add at user scope: gemini mcp add --scope user alphazede-sports azs-mcp-server serve

### ChatGPT Desktop

Config path: App Settings → Tools & Plugins → MCP Servers.

```json
{
  "command": "azs-mcp-server",
  "args": ["serve"]
}
```

> macOS only (as of 2025). MCP support is not available in the Windows or Linux ChatGPT Desktop apps. Check App Settings → MCP Servers.

### Zed

Config path:
- Project: .zed/settings.json
- Global: ~/.config/zed/settings.json

```json
{
  "context_servers": {
    "alphazede-sports": {
      "command": {
        "path": "azs-mcp-server",
        "args": ["serve"]
      }
    }
  }
}
```

> Zed uses the context_servers key. Restart Zed after editing settings.

### Continue

Config path: .continue/config.json (project) or ~/.continue/config.json (user).

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "azs-mcp-server",
          "args": ["serve"]
        }
      }
    ]
  }
}
```

> Add the entry inside the experimental.modelContextProtocolServers array in your Continue config.

### Windsurf

Config path: ~/.codeium/windsurf/mcp_settings.json

```json
{
  "mcpServers": {
    "alphazede-sports": {
      "command": "azs-mcp-server",
      "args": ["serve"]
    }
  }
}
```

> Create the file if it does not exist.

### Open Interpreter

Config path: Profile config or CLI flag.

```bash
interpreter --mcp-server "azs-mcp-server serve"
```

> Or add to your Open Interpreter profile under mcp_servers. See Open Interpreter documentation for the current config file location.

<!-- install:end -->

## HTTP Transport Variant

Stdio is the default transport for desktop and CLI MCP hosts. For assistant
actions, the browser extension, and local HTTP development, start the streamable
HTTP transport:

```bash
azs-mcp-server serve --http :3000
```

Local HTTP binds to loopback by default. Production non-loopback binding requires
both an explicit flag and an environment assertion:

```bash
AZS_MCP_PRODUCTION=1 azs-mcp-server serve --http 0.0.0.0:3000 --allow-non-loopback
```

Terminate TLS at the reverse proxy in production. Do not expose plain HTTP
directly on a public interface.

OAuth protected-resource discovery is available at:

```text
/.well-known/oauth-protected-resource
```

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `AZS_API_URL` | Upstream AlphaZede Sports API base URL. | `https://api.alphazedesports.com` |
| `AZS_API_KEY` | Optional local token fallback. OAuth token storage is preferred. System tokens require `AZS_MCP_DEV_MODE=1` and stdio. | Unset |
| `AZS_LOG_LEVEL` | Server log level. | `info` |
| `AZS_TIMEZONE` | Timezone used by date/time formatting helpers. | `America/New_York` |
| `AZS_MCP_CLIENT_ID` | Default OAuth client ID and outbound gateway attribution when token storage does not provide one. | Assigned per integration |
| `AZS_MCP_DEV_MODE` | Enables stdio-only SystemToken development mode when set to `1`; HTTP transport refuses to start in this mode. | Unset |
| `AZS_MCP_PRODUCTION` | Required as `1` for non-loopback HTTP binding. | Unset |
| `AZS_MCP_OBS_DEST` | Observability event destination: `stderr`, `file:/path/to/events.jsonl`, or `upstream`. | `stderr` |
| `AZS_MCP_OBS_HMAC_SECRET` | Optional 32-byte hex HMAC key for stable `params_hash` and `identity_key` correlation across restarts. | Random process key |
| `AZS_MCP_LOGIN_TIMEOUT_MS` | OAuth login callback timeout in milliseconds. | `300000` |
| `AZS_MCP_HTTP_RATE_LIMIT_PER_MIN` | Per-token HTTP request limit per minute. | `100` |
| `AZS_MCP_HTTP_MAX_INFLIGHT` | Global maximum number of in-flight HTTP requests. | `50` |

## Technical Reference

See the public developer repository docs for MCP installation, authentication, and API usage guidance.

## License

[Apache-2.0](./LICENSE) © 2026 AlphaZede Sports

## Maintainer

AlphaZede Sports platform engineering.
