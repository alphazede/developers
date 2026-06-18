import {
  bearerAuthorizationHeader,
  isValidBearerToken,
} from "../auth-token.js";
import { classifyIdentity } from "../identity-classifier.js";
import { writeCliStderr, writeCliStdout } from "../output-sink-registry.js";
import { readToken } from "../token-store.js";
import { buildApiUrl, normalizeApiBaseUrl } from "../url-utils.js";
import { resolveMcpClientId } from "./client-id.js";

const TOTAL_TOOLS = 13;

interface McpToolsResponse {
  tier: string;
  tier_display: string;
  tools: string[];
}

export async function runWhoami(args: string[] = []): Promise<number> {
  let token: string | null;
  try {
    token = readToken();
  } catch (error) {
    writeCliStderr(
      `${error instanceof Error ? error.message : String(error)} Run \`azs-mcp-server login\` to re-authenticate.\n`,
    );
    return 1;
  }
  if (!token) {
    writeCliStdout(
      "Not logged in. Run `azs-mcp-server login` to authenticate.\n",
    );
    return 1;
  }
  if (!isValidBearerToken(token)) {
    writeCliStderr(
      "Stored MCP token is invalid. Run `azs-mcp-server login` to re-authenticate.\n",
    );
    return 1;
  }

  const apiUrl = resolveApiUrl(args);
  if (apiUrl.ok === false) {
    writeCliStderr(`${apiUrl.error}\n`);
    return 1;
  }
  const identity = classifyIdentity(token);
  const clientId = resolveMcpClientId(args, { useDefault: false });
  let exitCode = 0;

  let response: Response;
  try {
    response = await fetch(buildApiUrl(apiUrl.value, "/api/v1/me/mcp-tools"), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: bearerAuthorizationHeader(token),
      },
    });
  } catch {
    writeCliStderr(
      `Could not reach API at ${apiUrl.value}. Check connectivity.\n`,
    );
    return 1;
  }

  if (response.status === 401) {
    writeCliStderr(
      "Token expired or invalid. Run `azs-mcp-server login` to re-authenticate.\n",
    );
    exitCode = 1;
  } else if (!response.ok) {
    writeCliStderr(`API returned HTTP ${response.status}.\n`);
    exitCode = 1;
  } else {
    try {
      const body = (await response.json()) as McpToolsResponse;
      if (!isMcpToolsResponse(body)) {
        throw new Error("invalid shape");
      }
      writeCliStdout(`Token kind: ${identity.kind}\n`);
      if (clientId) {
        writeCliStdout(`Client ID: ${clientId}\n`);
      }
      writeCliStdout(`Tier: ${body.tier_display || body.tier}\n`);
      writeCliStdout(
        `Tools: ${body.tools.length} of ${TOTAL_TOOLS} available\n`,
      );
      for (const tool of body.tools) {
        writeCliStdout(`  - ${tool}\n`);
      }
    } catch {
      writeCliStderr("Unexpected response shape from /api/v1/me/mcp-tools.\n");
      exitCode = 1;
    }
  }

  return exitCode;
}

type ApiUrlResult = { ok: true; value: string } | { error: string; ok: false };

function resolveApiUrl(args: string[]): ApiUrlResult {
  const flag = args.find((arg) => arg.startsWith("--api-url="));
  const value = flag?.slice("--api-url=".length) || process.env.AZS_API_URL;
  try {
    return {
      ok: true,
      value: normalizeApiBaseUrl(value || "https://api.alphazedesports.com"),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

function isMcpToolsResponse(value: unknown): value is McpToolsResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Partial<McpToolsResponse>;
  return (
    typeof response.tier === "string" &&
    typeof response.tier_display === "string" &&
    Array.isArray(response.tools) &&
    response.tools.every((tool) => typeof tool === "string")
  );
}
