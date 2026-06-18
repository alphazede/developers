import { bearerAuthorizationHeader, isValidBearerToken } from "./auth-token.js";
import type { AzsClient } from "./client.js";
import { buildApiUrl } from "./url-utils.js";

/** Cached allowlist response from upstream /api/v1/me/mcp-tools. */
interface Allowlist {
  tier: string;
  tier_display: string;
  tools: readonly string[];
  fetched_at: number;
}

interface AllowlistResponse {
  tier: string;
  tier_display: string;
  tools: readonly string[];
}

const DEFAULT_ALLOWLIST_TTL_MS = 60_000;

/** Fetch allowlist via the AzsClient. Returns null on auth/network failure. */
export async function fetchAllowlist(
  client: AzsClient,
): Promise<Allowlist | null> {
  const runtime = client.getRuntimeForAllowlist();
  if (!isValidBearerToken(runtime.token)) {
    return null;
  }
  const authorization = bearerAuthorizationHeader(runtime.token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);

  try {
    const response = await fetch(
      buildApiUrl(runtime.baseUrl, "/api/v1/me/mcp-tools"),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: authorization,
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as unknown;
    if (!isAllowlistResponse(body)) {
      return null;
    }

    return {
      tier: body.tier,
      tier_display: body.tier_display,
      tools: body.tools,
      fetched_at: Date.now(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-session in-memory cache. The key is the AzsClient instance.
 *
 * Each AzsClient instance gets at most one allowlist fetch within its lifetime.
 * HTTP transport intentionally constructs fresh AzsClient instances for inbound
 * requests, so this cache does not persist allowlists across HTTP requests.
 * That keeps tier/tool revocation checks immediate.
 */
export class AllowlistCache {
  readonly #cache = new WeakMap<AzsClient, Allowlist>();

  constructor(private readonly ttlMs = DEFAULT_ALLOWLIST_TTL_MS) {}

  get(client: AzsClient): Allowlist | null {
    const allowlist = this.#cache.get(client);
    if (!allowlist) {
      return null;
    }

    if (Date.now() - allowlist.fetched_at > this.ttlMs) {
      this.#cache.delete(client);
      return null;
    }

    return allowlist;
  }

  set(client: AzsClient, allowlist: Allowlist): void {
    this.#cache.set(client, allowlist);
  }
}

export async function getAllowlistForClient(
  client: AzsClient,
  cache: AllowlistCache,
): Promise<Allowlist | null> {
  const cached = cache.get(client);
  if (cached) {
    return cached;
  }

  const allowlist = await fetchAllowlist(client);
  if (allowlist) {
    cache.set(client, allowlist);
  }
  return allowlist;
}

export async function assertToolAllowed(
  client: AzsClient,
  cache: AllowlistCache,
  toolName: string,
): Promise<void> {
  const allowlist = await getAllowlistForClient(client, cache);
  if (!allowlist?.tools.includes(toolName)) {
    throw new Error("Tool is not allowed for this account.");
  }
}

function isAllowlistResponse(value: unknown): value is AllowlistResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as Partial<AllowlistResponse>;
  return (
    typeof response.tier === "string" &&
    typeof response.tier_display === "string" &&
    Array.isArray(response.tools) &&
    response.tools.every((tool) => typeof tool === "string")
  );
}
