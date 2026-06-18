const MCP_CLIENT_IDS = [
  "azs-claude-mcp",
  "azs-cursor-mcp",
  "azs-codex-mcp",
  "azs-gemini-mcp",
] as const;

type McpClientId = (typeof MCP_CLIENT_IDS)[number];

const DEFAULT_MCP_CLIENT_ID: McpClientId = "azs-claude-mcp";

export function resolveMcpClientId(
  args: string[],
  options: { useDefault: true },
): McpClientId;
export function resolveMcpClientId(
  args: string[],
  options: { useDefault: false },
): McpClientId | null;
export function resolveMcpClientId(
  args: string[],
  options: { useDefault: boolean },
): McpClientId | null {
  const flag = args.find((arg) => arg.startsWith("--client="));
  const value =
    flag?.slice("--client=".length) ||
    process.env.AZS_MCP_CLIENT_ID ||
    (options.useDefault ? DEFAULT_MCP_CLIENT_ID : null);

  if (!value) {
    return null;
  }

  if (MCP_CLIENT_IDS.includes(value as McpClientId)) {
    return value as McpClientId;
  }

  throw new Error(
    `Invalid MCP client_id "${value}". Expected one of: ${MCP_CLIENT_IDS.join(", ")}.`,
  );
}
