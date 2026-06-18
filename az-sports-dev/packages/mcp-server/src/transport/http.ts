import { randomUUID } from "node:crypto";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AzsClient, type AzsClientConfig } from "../client.js";
import { resolveIdentityFromAuthorizationHeader } from "../middleware.js";
import { type Emitter, RequestScopedEmitter } from "../observability.js";
import { writeCliStderr } from "../output-sink-registry.js";
import type { Transport } from "./index.js";
import {
  applyRateLimit,
  extractAuth,
  type Phase7,
  type PhaseResult,
  parseBody,
  parsePath,
  validateAuth,
  validateBinding,
  validateHeaders,
  validateMethod,
} from "./request-validation.js";

export const MAX_HTTP_BODY_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 50;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export interface HttpTransportOptions {
  host: string;
  port: number;
  allowNonLoopback: boolean;
  isProduction: boolean;
}

interface HttpTransportDeps {
  config: AzsClientConfig;
  emitter: Emitter;
  clientId: string;
  createServer?: (emitter?: Emitter) => McpServer;
}

export class StreamableHttpTransport implements Transport {
  readonly kind = "http" as const;
  #listener: Server | null = null;
  #server: McpServer | null = null;
  #activeSdkTransports = new Set<StreamableHTTPServerTransport>();
  #inFlight = new Set<Promise<void>>();
  #rateLimiter: SlidingWindowRateLimiter;
  #maxInFlightRequests: number;

  constructor(
    private opts: HttpTransportOptions,
    private deps: HttpTransportDeps,
  ) {
    this.#rateLimiter = new SlidingWindowRateLimiter(
      readPositiveIntegerEnv(
        "AZS_MCP_HTTP_RATE_LIMIT_PER_MIN",
        DEFAULT_RATE_LIMIT_PER_MINUTE,
      ),
    );
    this.#maxInFlightRequests = readPositiveIntegerEnv(
      "AZS_MCP_HTTP_MAX_INFLIGHT",
      DEFAULT_MAX_IN_FLIGHT_REQUESTS,
    );
  }

  async start(server: McpServer): Promise<void> {
    this.validateBindConfig();
    if (!this.deps.createServer) {
      throw new Error(
        "HTTP transport requires a per-request createServer factory.",
      );
    }
    this.#server = server;

    this.#listener = http.createServer((req, res) => {
      if (this.#inFlight.size >= this.#maxInFlightRequests) {
        writeJson(
          res,
          429,
          { error: "too_many_requests", trace_id: randomUUID() },
          { "Retry-After": "1" },
        );
        return;
      }

      const work = this.handleRequest(req, res)
        .catch(() => {
          if (!res.headersSent && !res.destroyed) {
            writeJson(res, 500, {
              error: "internal_error",
              trace_id: randomUUID(),
            });
          }
        })
        .finally(() => {
          this.#inFlight.delete(work);
        });
      this.#inFlight.add(work);
    });

    await new Promise<void>((resolve, reject) => {
      this.#listener?.once("error", reject);
      this.#listener?.listen(this.opts.port, this.opts.host, () => {
        this.#listener?.off("error", reject);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    const closeListener = this.#listener
      ? new Promise<void>((resolve, reject) => {
          this.#listener?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
      : Promise.resolve();

    await closeListener;
    await Promise.allSettled([...this.#inFlight]);
    await Promise.allSettled(
      [...this.#activeSdkTransports].map((transport) => transport.close()),
    );
    await this.#server?.close();
    await this.deps.emitter.flush?.();
    this.#listener = null;
    this.#server = null;
  }

  get url(): string {
    const address = this.#listener?.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP transport is not listening.");
    }
    const host = address.address === "::1" ? "[::1]" : address.address;
    return `http://${host}:${address.port}`;
  }

  validateBindConfig(): void {
    if (process.env.AZS_MCP_DEV_MODE === "1") {
      throw new Error(
        "HTTP transport is not allowed in dev mode (AZS_MCP_DEV_MODE=1). Use stdio.",
      );
    }

    const host = this.opts.host;
    const isLoopback =
      host === "127.0.0.1" || host === "::1" || host === "localhost";

    if (!isLoopback) {
      if (!this.opts.allowNonLoopback) {
        throw new Error(
          `Non-loopback bind to ${host} requires --allow-non-loopback flag and AZS_MCP_PRODUCTION=1 env (operator must assert TLS termination at reverse proxy).`,
        );
      }
      if (!this.opts.isProduction) {
        throw new Error(
          `Non-loopback bind to ${host} requires AZS_MCP_PRODUCTION=1 env (operator must assert TLS termination at reverse proxy).`,
        );
      }
      writeCliStderr(
        `[WARN] Binding to ${host}; ensure TLS termination at reverse proxy.\n`,
      );
    }
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const phase0 = parsePath(req);
    if (this.writeTerminalPhase(req, res, phase0)) return;

    const phase1 = validateMethod(phase0.phase);
    if (this.writeTerminalPhase(req, res, phase1)) return;

    const phase2 = validateBinding(phase1.phase, {
      validateRequestBinding: (request) => this.validateRequestBinding(request),
    });
    if (this.writeTerminalPhase(req, res, phase2)) return;

    const phase3 = validateHeaders(phase2.phase);
    if (this.writeTerminalPhase(req, res, phase3)) return;

    const phase4 = applyRateLimit(phase3.phase, this.#rateLimiter);
    if (this.writeTerminalPhase(req, res, phase4)) return;

    const phase5 = extractAuth(phase4.phase);
    if (this.writeTerminalPhase(req, res, phase5)) return;

    const phase6 = validateAuth(phase5.phase);
    if (this.writeTerminalPhase(req, res, phase6)) return;

    const phase7 = await parseBody(phase6.phase, MAX_HTTP_BODY_BYTES);
    if (this.writeTerminalPhase(req, res, phase7)) return;

    await this.dispatch(req, res, phase7.phase);
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    phase: Phase7,
  ): Promise<void> {
    try {
      const createServer = this.deps.createServer;
      if (!createServer) {
        throw new Error("HTTP transport has not been started.");
      }
      const requestEmitter = this.createRequestEmitter(phase);
      const requestServer = createServer(requestEmitter);
      const sdkTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      this.#activeSdkTransports.add(sdkTransport);
      let cleanupStarted = false;
      let flushStarted = false;
      const flushRequestEmitter = () => {
        if (!(requestEmitter instanceof RequestScopedEmitter) || flushStarted) {
          return;
        }
        flushStarted = true;
        void requestEmitter.flush?.();
      };
      const closeRequestTransport = async () => {
        if (cleanupStarted) {
          return;
        }
        cleanupStarted = true;
        this.#activeSdkTransports.delete(sdkTransport);
        try {
          await sdkTransport.close();
        } finally {
          await requestServer.close();
        }
      };
      res.once("finish", () => {
        flushRequestEmitter();
        void closeRequestTransport();
      });
      res.once("close", () => {
        flushRequestEmitter();
        void closeRequestTransport();
      });
      await requestServer.connect(sdkTransport);
      await sdkTransport.handleRequest(req, res, phase.body);
    } catch {
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: "internal_error",
          trace_id: phase.traceId,
        });
      } else {
        res.end();
      }
    }
  }

  private createRequestEmitter(phase: Phase7): Emitter {
    if (process.env.AZS_MCP_OBS_DEST !== "upstream") {
      return this.deps.emitter;
    }

    return new RequestScopedEmitter(
      new AzsClient(
        this.deps.config,
        resolveIdentityFromAuthorizationHeader(phase.req.headers.authorization),
        undefined,
        this.deps.clientId,
      ),
    );
  }

  private writeTerminalPhase(
    req: IncomingMessage,
    res: ServerResponse,
    result: PhaseResult<unknown>,
  ): result is Exclude<PhaseResult<unknown>, { kind: "ok" }> {
    if (result.kind === "ok") {
      return false;
    }
    if (result.kind === "stop") {
      return true;
    }
    writeJson(
      res,
      result.status,
      result.body,
      result.headers ?? {},
      result.kind === "done" ? result.omitBody : false,
    );
    if (result.closeConnection) {
      closeAfterResponse(res, req);
    }
    return true;
  }

  private validateRequestBinding(
    req: IncomingMessage,
  ): { status: number; error: string } | null {
    if (!isLoopbackHost(this.opts.host)) {
      return null;
    }

    const allowedHosts = this.allowedHostHeaders();
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      return { status: 421, error: "host_not_allowed" };
    }

    const origin = req.headers.origin;
    if (!origin) {
      return null;
    }
    if (!this.allowedOrigins().has(origin.toLowerCase())) {
      return { status: 403, error: "origin_not_allowed" };
    }

    return null;
  }

  private allowedHostHeaders(): Set<string> {
    const address = this.#listener?.address();
    const port =
      address && typeof address !== "string" ? address.port : this.opts.port;
    return new Set(
      [
        "127.0.0.1",
        `127.0.0.1:${port}`,
        "localhost",
        `localhost:${port}`,
        "[::1]",
        `[::1]:${port}`,
        "::1",
        `::1:${port}`,
      ].map((host) => host.toLowerCase()),
    );
  }

  private allowedOrigins(): Set<string> {
    return new Set(
      [...this.allowedHostHeaders()].map((host) => `http://${host}`),
    );
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  omitBody = false,
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(omitBody ? undefined : JSON.stringify(body));
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

class SlidingWindowRateLimiter {
  #requestsByKey = new Map<string, number[]>();

  constructor(private limit: number) {}

  check(
    key: string,
    nowMs = Date.now(),
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const windowStart = nowMs - RATE_LIMIT_WINDOW_MS;
    const current = (this.#requestsByKey.get(key) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );

    if (current.length >= this.limit) {
      this.#requestsByKey.set(key, current);
      const oldest = current[0] ?? nowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - nowMs) / 1000),
        ),
      };
    }

    current.push(nowMs);
    this.#requestsByKey.set(key, current);
    return { allowed: true };
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function closeAfterResponse(res: ServerResponse, req: IncomingMessage): void {
  res.shouldKeepAlive = false;
  res.once("finish", () => {
    req.destroy();
  });
}
