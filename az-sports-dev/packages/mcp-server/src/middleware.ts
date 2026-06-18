import { randomBytes } from "node:crypto";
import type { RequestInfo } from "@modelcontextprotocol/sdk/types.js";
import { AzsClient, type AzsClientConfig, loadConfig } from "./client.js";
import { AzsApiError } from "./errors.js";
import { identityKey, paramsHash } from "./hmac-keys.js";
import { filterForwardedHeaders } from "./http-headers.js";
import { classifyIdentity } from "./identity-classifier.js";
import { mcpTraceTextContent } from "./output-sink-registry.js";
import {
  DEFAULT_MCP_CLIENT_ID,
  readClientId,
  readToken,
} from "./token-store.js";
import type { Identity, ObsEventEnd, ToolContext } from "./tool.js";
import { log } from "./util.js";

export interface MiddlewareContext extends ToolContext {
  current_tool: string;
  transport: "stdio" | "http";
  upstream_status: number | null;
  client_id: string | null;
  // Set by mapError for returned error envelopes and future non-throwing error paths.
  error_code: string | null;
  request_info?: RequestInfo;
  forwarded_headers?: Headers;
}

declare const middlewarePhase: unique symbol;

type PhaseContext<Name extends string> = MiddlewareContext & {
  readonly [middlewarePhase]?: Name;
};

export type TracePendingContext = PhaseContext<"trace_pending">;
export type TraceBoundContext = PhaseContext<"trace_bound">;
export type ErrorMappedContext = PhaseContext<"error_mapped">;
export type IdentityBoundContext = PhaseContext<"identity_bound">;

export type ToolHandler<Ctx extends MiddlewareContext = MiddlewareContext> = (
  ctx: Ctx,
  input: unknown,
) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

export type Middleware<
  In extends MiddlewareContext = MiddlewareContext,
  Out extends MiddlewareContext = In,
> = (next: ToolHandler<Out>) => ToolHandler<In>;

type AnyMiddleware = Middleware<MiddlewareContext, MiddlewareContext>;

type MiddlewareIn<T> =
  T extends Middleware<infer In, MiddlewareContext> ? In : never;

type MiddlewareOut<T> =
  T extends Middleware<MiddlewareContext, infer Out> ? Out : never;

type PipelineIn<T extends readonly AnyMiddleware[]> = number extends T["length"]
  ? MiddlewareContext
  : T extends readonly [infer First extends AnyMiddleware, ...AnyMiddleware[]]
    ? MiddlewareIn<First>
    : MiddlewareContext;

type PipelineOut<T extends readonly AnyMiddleware[]> =
  number extends T["length"]
    ? MiddlewareContext
    : T extends readonly [...AnyMiddleware[], infer Last extends AnyMiddleware]
      ? MiddlewareOut<Last>
      : MiddlewareContext;

type ValidatePipeline<T extends readonly AnyMiddleware[]> =
  number extends T["length"]
    ? T
    : T extends readonly []
      ? T
      : T extends readonly [AnyMiddleware]
        ? T
        : T extends readonly [
              infer First extends AnyMiddleware,
              infer Second extends AnyMiddleware,
              ...infer Rest extends AnyMiddleware[],
            ]
          ? MiddlewareOut<First> extends MiddlewareIn<Second>
            ? readonly [First, ...ValidatePipeline<readonly [Second, ...Rest]>]
            : never
          : T;

export function composeMiddleware<const T extends readonly AnyMiddleware[]>(
  middlewares: T & ValidatePipeline<T>,
): Middleware<PipelineIn<T>, PipelineOut<T>> {
  return middlewares.reduceRight<Middleware>(
    (nextMiddleware, middleware) => (handler) =>
      middleware(nextMiddleware(handler)),
    (handler) => handler,
  ) as unknown as Middleware<PipelineIn<T>, PipelineOut<T>>;
}

export function identityMiddleware(
  config: AzsClientConfig,
): Middleware<ErrorMappedContext, IdentityBoundContext> {
  return (next) => async (ctx, input) => {
    let identity: Identity;
    try {
      identity = resolveIdentityForContext(ctx);
    } catch (error) {
      emitAuthFailure(ctx, input);
      throw error;
    }

    ctx.identity = identity;
    ctx.client_id = resolveClientId();
    // Reset defensively for direct middleware tests and any future ctx reuse.
    ctx.upstream_status = null;
    ctx.error_code = null;
    ctx.client = new AzsClient(
      config,
      identity,
      ctx.current_tool,
      ctx.client_id ?? DEFAULT_MCP_CLIENT_ID,
      (status) => {
        ctx.upstream_status = status;
      },
      ctx.forwarded_headers,
    );
    return next(ctx as unknown as IdentityBoundContext, input);
  };
}

export const extractIdentity: Middleware<
  ErrorMappedContext,
  IdentityBoundContext
> = (next) => async (ctx, input) =>
  identityMiddleware(loadConfig())(next)(ctx, input);

export function resolveIdentity(): Identity {
  let token: string | undefined;

  if (process.env.AZS_API_KEY) {
    token = process.env.AZS_API_KEY;
  } else {
    token = readToken() ?? undefined;
  }

  if (!token) {
    throw new Error(
      "No authentication token found. Run `azs-mcp-server login` to authenticate, or set AZS_API_KEY for dev mode.",
    );
  }

  let identity: Identity;
  try {
    identity = classifyIdentity(token);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Empty token cannot be classified"
    ) {
      throw new Error(
        "No authentication token found. Run `azs-mcp-server login` to authenticate, or set AZS_API_KEY for dev mode.",
      );
    }
    throw error;
  }

  if (identity.kind === "system" && process.env.AZS_MCP_DEV_MODE !== "1") {
    throw new Error(
      "SystemToken authentication is only allowed in dev mode. Set AZS_MCP_DEV_MODE=1 (stdio only) to enable, or use an OAuth/ApiKey token.",
    );
  }

  return identity;
}

export function resolveIdentityFromAuthorizationHeader(
  authorization: string | string[] | undefined,
): Identity {
  const token = bearerTokenFromAuthorization(authorization);
  if (!token) {
    throw new Error("HTTP Authorization header must be 'Bearer <token>'.");
  }

  const identity = classifyIdentity(token);
  if (identity.kind === "system" && process.env.AZS_MCP_DEV_MODE !== "1") {
    throw new Error(
      "SystemToken authentication is only allowed in dev mode. Set AZS_MCP_DEV_MODE=1 (stdio only) to enable, or use an OAuth/ApiKey token.",
    );
  }

  return identity;
}

export function bearerTokenFromAuthorization(
  authorization: string | string[] | undefined,
): string | null {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function resolveIdentityForContext(ctx: MiddlewareContext): Identity {
  if (ctx.transport !== "http") {
    return resolveIdentity();
  }

  return resolveIdentityFromAuthorizationHeader(
    ctx.request_info?.headers.authorization,
  );
}

export function forwardedHeadersFromRequestInfo(
  requestInfo: RequestInfo | undefined,
): Headers | undefined {
  if (!requestInfo) {
    return undefined;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(requestInfo.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return filterForwardedHeaders(headers);
}

export function resolveClientId(): string {
  const clientId =
    process.env.AZS_MCP_CLIENT_ID || readClientId() || DEFAULT_MCP_CLIENT_ID;
  if (!/^azs-(claude|cursor|codex|gemini)-mcp$/.test(clientId)) {
    throw new Error(`Invalid MCP client_id: ${clientId}`);
  }
  return clientId;
}

export const attachTraceId: Middleware<TracePendingContext, TraceBoundContext> =
  (next) => async (ctx, input) => {
    ctx.trace_id = uuidv7();
    return next(ctx as unknown as TraceBoundContext, input);
  };

export const mapError: Middleware<TraceBoundContext, ErrorMappedContext> =
  (next) => async (ctx, input) => {
    try {
      return await next(ctx as unknown as ErrorMappedContext, input);
    } catch (error: unknown) {
      const traceId = ctx.trace_id || "unknown";
      let userMessage: string;
      let errorCode: string;

      if (error instanceof AzsApiError) {
        errorCode = error.code ?? `http_${error.statusCode}`;
        log(
          "warn",
          `API error statusCode=${error.statusCode} code=${errorCode} trace_id=${traceId}`,
        );
        userMessage = error.userMessage;
      } else {
        log("error", `Unexpected error trace_id=${traceId}`);
        userMessage = "An unexpected error occurred. Try again in a moment.";
        errorCode = "unexpected";
      }

      ctx.error_code = errorCode;
      return errorEnvelope(userMessage, traceId);
    }
  };

export const emitObservability: Middleware<
  IdentityBoundContext,
  IdentityBoundContext
> = (next) => async (ctx, input) => {
  const startMs = Date.now();
  const identityKeyValue = identityKey(
    identityFingerprintSourceOf(ctx.identity),
  );
  const common = {
    trace_id: ctx.trace_id,
    tool: ctx.current_tool,
    identity_key: identityKeyValue,
    client_id: ctx.client_id,
    transport: ctx.transport,
  } as const;
  let result: Awaited<ReturnType<ToolHandler>> | undefined;
  let thrown: unknown;

  ctx.emit({
    event: "tool.call.start",
    ts: new Date(startMs).toISOString(),
    ...common,
    params_hash: paramsHash(input),
  });

  try {
    result = await next(ctx, input);
    return result;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const endMs = Date.now();
    ctx.emit({
      event: "tool.call.end",
      ts: new Date(endMs).toISOString(),
      ...common,
      latency_ms: Math.max(0, endMs - startMs),
      status: classifyStatus(result, thrown, ctx.error_code),
      upstream_status: ctx.upstream_status,
    });
  }
};

function classifyStatus(
  result: Awaited<ReturnType<ToolHandler>> | undefined,
  thrown: unknown,
  errorCode: string | null,
): ObsEventEnd["status"] {
  if (thrown !== undefined) {
    if (thrown instanceof AzsApiError) {
      return classifyApiErrorStatus(thrown.code, thrown.statusCode);
    }
    return "unexpected_error";
  }

  if (!result?.isError) {
    return "ok";
  }

  if (errorCode) {
    return classifyErrorCodeStatus(errorCode);
  }

  // Last-resort heuristic for future leaves that return error envelopes without setting error_code.
  const text = result.content[0]?.text ?? "";
  if (text.includes("Token expired")) {
    return "auth_error";
  }
  if (text.includes("rate limit") || text.includes("quota")) {
    return "quota_exceeded";
  }
  return "upstream_error";
}

function classifyApiErrorStatus(
  code: string | undefined,
  statusCode: number,
): ObsEventEnd["status"] {
  if (statusCode === 401 || code === "auth_error" || code === "token_expired") {
    return "auth_error";
  }
  if (
    statusCode === 429 ||
    code === "quota_exceeded" ||
    code === "rate_limit"
  ) {
    return "quota_exceeded";
  }
  return "upstream_error";
}

function classifyErrorCodeStatus(errorCode: string): ObsEventEnd["status"] {
  if (
    errorCode === "http_401" ||
    errorCode === "auth_error" ||
    errorCode === "token_expired"
  ) {
    return "auth_error";
  }
  if (
    errorCode === "http_429" ||
    errorCode === "quota_exceeded" ||
    errorCode === "rate_limit"
  ) {
    return "quota_exceeded";
  }
  if (errorCode === "unexpected") {
    return "unexpected_error";
  }
  return "upstream_error";
}

function identityFingerprintSourceOf(identity: Identity): string {
  switch (identity.kind) {
    case "oauth":
      return `oauth:${last16(identity.token)}`;
    case "api_key":
      return `apikey:${last16(identity.token)}`;
    case "system":
      return `system:${last16(identity.token)}`;
  }
}

function last16(token: string): string {
  return token.slice(-16);
}

function emitAuthFailure(ctx: MiddlewareContext, input: unknown): void {
  const startMs = Date.now();
  const common = {
    trace_id: ctx.trace_id,
    tool: ctx.current_tool,
    identity_key: identityKey("auth:unresolved"),
    client_id: ctx.client_id,
    transport: ctx.transport,
  } as const;

  ctx.upstream_status = null;
  ctx.error_code = "auth_error";
  ctx.emit({
    event: "tool.call.start",
    ts: new Date(startMs).toISOString(),
    ...common,
    params_hash: paramsHash(input),
  });

  const endMs = Date.now();
  ctx.emit({
    event: "tool.call.end",
    ts: new Date(endMs).toISOString(),
    ...common,
    latency_ms: Math.max(0, endMs - startMs),
    status: "auth_error",
    upstream_status: null,
  });
}

function errorEnvelope(userMessage: string, traceId: string) {
  return {
    content: [mcpTraceTextContent(userMessage, traceId)],
    isError: true,
  };
}

function uuidv7(): string {
  const ts = BigInt(Date.now());
  const rand = randomBytes(10);
  const randInt = rand.reduce(
    (value, byte) => (value << 8n) | BigInt(byte),
    0n,
  );
  const randA = (randInt >> 68n) & 0xfffn;
  const randB = (randInt >> 6n) & 0x3fff_ffff_ffff_ffffn;
  const bytes = new Uint8Array(16);

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | Number((randA >> 8n) & 0x0fn);
  bytes[7] = Number(randA & 0xffn);
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  bytes[9] = Number((randB >> 48n) & 0xffn);
  bytes[10] = Number((randB >> 40n) & 0xffn);
  bytes[11] = Number((randB >> 32n) & 0xffn);
  bytes[12] = Number((randB >> 24n) & 0xffn);
  bytes[13] = Number((randB >> 16n) & 0xffn);
  bytes[14] = Number((randB >> 8n) & 0xffn);
  bytes[15] = Number(randB & 0xffn);

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
