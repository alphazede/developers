/**
 * Allowlisted headers forwarded from MCP HTTP request to upstream API.
 * Anything else is dropped.
 */
const FORWARDED_HEADER_ALLOWLIST = [
  "authorization",
  "content-type",
  "accept",
  "x-trace-id",
  "user-agent",
  "x-mcp-tool",
] as const;

const FORWARDED_HEADERS = new Set<string>(FORWARDED_HEADER_ALLOWLIST);

/**
 * Validate inbound HTTP headers from MCP client.
 * Returns null on success; returns an error response shape on failure.
 */
export function validateInboundHeaders(headers: Headers): {
  error: string;
  status: number;
  body: { error: string; trace_id?: string };
} | null {
  if (headers.has("cookie")) {
    return {
      error: "cookie_not_supported",
      status: 400,
      body: { error: "cookie_not_supported" },
    };
  }

  return null;
}

/**
 * Filter a Headers object down to FORWARDED_HEADER_ALLOWLIST.
 * Used when forwarding to upstream AzsClient.
 */
export function filterForwardedHeaders(headers: Headers): Headers {
  const forwarded = new Headers();

  for (const [name, value] of headers.entries()) {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) {
      forwarded.set(name, value);
    }
  }

  return forwarded;
}
