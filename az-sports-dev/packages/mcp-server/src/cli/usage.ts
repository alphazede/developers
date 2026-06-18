import {
  bearerAuthorizationHeader,
  isValidBearerToken,
} from "../auth-token.js";
import { writeCliStderr, writeCliStdout } from "../output-sink-registry.js";
import { readToken } from "../token-store.js";
import { buildApiUrl, normalizeApiBaseUrl } from "../url-utils.js";

interface UsageResponse {
  tier: string;
  tier_display: string;
  period: {
    start: string;
    end: string;
  };
  usage: {
    total_credits: number;
    limit: number | null;
    limit_enforcement: string;
    by_tool: Record<string, number>;
  };
}

export async function runUsage(args: string[] = []): Promise<number> {
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
    writeCliStderr(
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
  if (!apiUrl.ok) {
    writeCliStderr(`${apiUrl.error}\n`);
    return 1;
  }

  let response: Response;
  try {
    response = await fetch(buildApiUrl(apiUrl.value, "/api/v1/me/usage"), {
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
    return 1;
  }
  if (!response.ok) {
    writeCliStderr(`API returned HTTP ${response.status}.\n`);
    return 1;
  }

  let body: UsageResponse;
  try {
    body = (await response.json()) as UsageResponse;
    if (!isUsageResponse(body)) {
      throw new Error("invalid shape");
    }
  } catch {
    writeCliStderr("Unexpected response shape from /api/v1/me/usage.\n");
    return 1;
  }

  writeCliStdout(`Period: ${body.period.start} to ${body.period.end}\n`);
  writeCliStdout(`Tier: ${body.tier_display || body.tier}\n`);
  writeCliStdout(
    `Used: ${body.usage.total_credits.toLocaleString()} credits\n`,
  );
  if (body.usage.limit !== null) {
    const pct = ((body.usage.total_credits / body.usage.limit) * 100).toFixed(
      1,
    );
    writeCliStdout(
      `Limit: ${body.usage.limit.toLocaleString()} (${pct}% used) [advisory; not enforced]\n`,
    );
  } else {
    writeCliStdout("Limit: unlimited (Free Trial)\n");
  }
  writeCliStdout("By tool:\n");
  for (const [tool, credits] of Object.entries(body.usage.by_tool)) {
    writeCliStdout(`  ${tool}: ${credits.toLocaleString()}\n`);
  }

  return 0;
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

function isUsageResponse(value: unknown): value is UsageResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Partial<UsageResponse>;
  return (
    typeof response.tier === "string" &&
    typeof response.tier_display === "string" &&
    response.period !== undefined &&
    typeof response.period === "object" &&
    typeof response.period.start === "string" &&
    typeof response.period.end === "string" &&
    response.usage !== undefined &&
    typeof response.usage === "object" &&
    typeof response.usage.total_credits === "number" &&
    Number.isFinite(response.usage.total_credits) &&
    (response.usage.limit === null ||
      (typeof response.usage.limit === "number" &&
        Number.isFinite(response.usage.limit))) &&
    typeof response.usage.limit_enforcement === "string" &&
    response.usage.by_tool !== undefined &&
    typeof response.usage.by_tool === "object" &&
    !Array.isArray(response.usage.by_tool) &&
    Object.values(response.usage.by_tool).every(
      (credits) => typeof credits === "number" && Number.isFinite(credits),
    )
  );
}
