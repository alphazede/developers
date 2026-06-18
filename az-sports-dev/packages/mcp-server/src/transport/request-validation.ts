import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { validateInboundHeaders } from "../http-headers.js";
import {
  bearerTokenFromAuthorization,
  resolveIdentityFromAuthorizationHeader,
} from "../middleware.js";

const PINNED_RESOURCE = "https://api.alphazedesports.com";
const PINNED_AUTHORIZATION_SERVERS = [
  "https://api.alphazedesports.com/api/v1/oauth/authorize",
];
const PINNED_SCOPES = ["read", "read:arb", "read:sgp", "read:ml", "read:dfs"];
const PINNED_RESOURCE_METADATA_URL = `${PINNED_RESOURCE}/.well-known/oauth-protected-resource`;

export type PhaseOk<P> = { kind: "ok"; phase: P };
export type PhaseFail = {
  kind: "fail";
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  closeConnection?: boolean;
};
export type PhaseStop = { kind: "stop" };
export type PhaseDone = {
  kind: "done";
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  closeConnection?: boolean;
  omitBody?: boolean;
};
export type PhaseResult<P> = PhaseOk<P> | PhaseFail | PhaseStop | PhaseDone;

export type Phase0 = { req: IncomingMessage; url: URL };
export type Phase1 = Phase0 & { method: "POST" };
export type Phase2 = Phase1 & { traceId: string };
export type Phase3 = Phase2;
export type Phase4 = Phase3;
export type Phase5 = Phase4 & { bearerToken: string };
export type Phase6 = Phase5;
export type Phase7 = Phase6 & { body: unknown };

export interface BindingOpts {
  traceIdFactory?: () => string;
  validateRequestBinding: (
    req: IncomingMessage,
  ) => { status: number; error: string } | null;
}

export interface SlidingWindowRateLimiter {
  check(
    key: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number };
}

export function parsePath(req: IncomingMessage): PhaseResult<Phase0> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/.well-known/oauth-protected-resource") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return {
        kind: "fail",
        status: 405,
        body: { error: "method_not_allowed" },
      };
    }
    return {
      kind: "done",
      status: 200,
      body: oauthProtectedResourceMetadata(),
      headers: {},
      omitBody: req.method === "HEAD",
    };
  }

  if (url.pathname.startsWith("/.well-known/")) {
    return { kind: "fail", status: 404, body: { error: "not_found" } };
  }

  if (url.pathname !== "/") {
    return { kind: "fail", status: 404, body: { error: "not_found" } };
  }

  return { kind: "ok", phase: { req, url } };
}

export function validateMethod(input: Phase0): PhaseResult<Phase1> {
  if (input.req.method !== "POST") {
    return {
      kind: "fail",
      status: 405,
      body: { error: "method_not_allowed" },
    };
  }
  return { kind: "ok", phase: { ...input, method: "POST" } };
}

export function validateBinding(
  input: Phase1,
  opts: BindingOpts,
): PhaseResult<Phase2> {
  const traceId = opts.traceIdFactory?.() ?? randomUUID();
  const bindingError = opts.validateRequestBinding(input.req);
  if (bindingError) {
    return {
      kind: "fail",
      status: bindingError.status,
      body: { error: bindingError.error, trace_id: traceId },
    };
  }
  return { kind: "ok", phase: { ...input, traceId } };
}

export function validateHeaders(input: Phase2): PhaseResult<Phase3> {
  const inboundHeaderError = validateInboundHeaders(
    headersFromIncoming(input.req.headers),
  );
  if (inboundHeaderError) {
    return {
      kind: "fail",
      status: inboundHeaderError.status,
      body: { ...inboundHeaderError.body, trace_id: input.traceId },
    };
  }
  return { kind: "ok", phase: input };
}

export function applyRateLimit(
  input: Phase3,
  limiter: SlidingWindowRateLimiter,
): PhaseResult<Phase4> {
  const rateLimit = limiter.check(rateLimitKey(input.req));
  if (!rateLimit.allowed) {
    return {
      kind: "fail",
      status: 429,
      body: { error: "rate_limited", trace_id: input.traceId },
      headers: { "Retry-After": String((rateLimit as { retryAfterSeconds: number }).retryAfterSeconds) },
    };
  }
  return { kind: "ok", phase: input };
}

export function extractAuth(input: Phase4): PhaseResult<Phase5> {
  const bearerToken = bearerTokenFromAuthorization(
    input.req.headers.authorization,
  );
  if (!bearerToken) {
    return {
      kind: "fail",
      status: 401,
      body: { error: "unauthorized", trace_id: input.traceId },
      headers: {
        "WWW-Authenticate": authenticateHeader(false),
      },
    };
  }
  return { kind: "ok", phase: { ...input, bearerToken } };
}

export function validateAuth(input: Phase5): PhaseResult<Phase6> {
  try {
    resolveIdentityFromAuthorizationHeader(input.req.headers.authorization);
  } catch {
    return {
      kind: "fail",
      status: 401,
      body: { error: "unauthorized", trace_id: input.traceId },
      headers: {
        "WWW-Authenticate": authenticateHeader(true),
      },
    };
  }
  return { kind: "ok", phase: input };
}

export async function parseBody(
  input: Phase6,
  maxBytes: number,
): Promise<PhaseResult<Phase7>> {
  const bodyResult = await readLimitedJsonBody(input.req, maxBytes);
  if (!bodyResult.ok) {
    if ((bodyResult as { noResponse?: boolean }).noResponse) {
      return { kind: "stop" };
    }
    return {
      kind: "fail",
      status: (bodyResult as { status: number }).status,
      body: { error: (bodyResult as { error: string }).error, trace_id: input.traceId },
      headers: (bodyResult as { closeConnection?: boolean }).closeConnection ? { Connection: "close" } : {},
      closeConnection: (bodyResult as { closeConnection?: boolean }).closeConnection,
    };
  }
  return { kind: "ok", phase: { ...input, body: bodyResult.body } };
}

export function oauthProtectedResourceMetadata(): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
} {
  return {
    resource: PINNED_RESOURCE,
    authorization_servers: [...PINNED_AUTHORIZATION_SERVERS],
    scopes_supported: [...PINNED_SCOPES],
  };
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(name, entry);
      }
      continue;
    }
    if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function authenticateHeader(invalidToken: boolean): string {
  const parts = [
    'Bearer realm="azs-mcp"',
    `resource_metadata="${PINNED_RESOURCE_METADATA_URL}"`,
  ];
  if (invalidToken) {
    parts.push('error="invalid_token"');
  }
  return parts.join(", ");
}

function rateLimitKey(req: IncomingMessage): string {
  return `ip:${req.socket.remoteAddress ?? "unknown"}`;
}

type LimitedJsonBodyResult =
  | { ok: true; body: unknown }
  | {
      ok: false;
      status: number;
      error: string;
      closeConnection?: boolean;
      noResponse?: boolean;
    };

async function readLimitedJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<LimitedJsonBodyResult> {
  const contentLength = parseContentLength(req.headers["content-length"]);
  if (contentLength === "invalid") {
    return { ok: false, status: 400, error: "invalid_content_length" };
  }
  if (contentLength !== null && contentLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "payload_too_large",
      closeConnection: true,
    };
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const settle = (result: LimitedJsonBodyResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        req.pause();
        settle({
          ok: false,
          status: 413,
          error: "payload_too_large",
          closeConnection: true,
        });
        return;
      }
      chunks.push(buffer);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      try {
        settle({
          ok: true,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
      } catch {
        settle({ ok: false, status: 400, error: "invalid_json" });
      }
    });

    req.on("aborted", () => {
      settle({
        ok: false,
        status: 400,
        error: "client_aborted",
        closeConnection: true,
        noResponse: true,
      });
    });

    req.on("error", () => {
      settle({
        ok: false,
        status: 400,
        error: "request_stream_error",
        closeConnection: true,
      });
    });
  });
}

function parseContentLength(
  value: string | string[] | undefined,
): number | "invalid" | null {
  if (value === undefined) {
    return null;
  }
  const contentLength = Array.isArray(value) ? value[0] : value;
  if (contentLength === undefined) {
    return "invalid";
  }
  if (!/^\d+$/.test(contentLength)) {
    return "invalid";
  }
  const parsed = Number(contentLength);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}
