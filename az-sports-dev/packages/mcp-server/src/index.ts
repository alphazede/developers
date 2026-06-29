#!/usr/bin/env node

/**
 * AlphaZede Sports MCP Server -- Universal
 *
 * A Model Context Protocol server that wraps the AlphaZede Sports API.
 * Works with any MCP-compatible client.
 *
 * Configuration via environment variables:
 * - AZS_API_URL: API base URL (uses the configured runtime default if unset)
 * - API_KEY: optional local API key fallback
 * - AZS_LOG_LEVEL: log level (default: info)
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { objectFromShape } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool as McpToolDefinition,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AllowlistCache,
  assertToolAllowed,
  getAllowlistForClient,
} from "./allowlist.js";
import { type Command, dispatch, helpText } from "./cli/dispatcher.js";
import { runLogin, runLogout, runUsage, runWhoami } from "./cli/index.js";
import { parseServeArgs } from "./cli/serve.js";
import {
  AzsClient,
  type AzsClientConfig,
  loadConfig,
  PACKAGE_VERSION,
} from "./client.js";
import {
  attachTraceId,
  composeMiddleware,
  emitObservability,
  forwardedHeadersFromRequestInfo,
  identityMiddleware,
  type MiddlewareContext,
  mapError,
  resolveClientId,
  resolveIdentity,
  resolveIdentityFromAuthorizationHeader,
  type ToolHandler,
} from "./middleware.js";
import { createEmitter, type Emitter } from "./observability.js";
import {
  mcpTextContent,
  writeCliStderr,
  writeCliStdout,
} from "./output-sink-registry.js";
import type { Identity } from "./tool.js";
import { tools } from "./tools/index.js";
import { createTransport } from "./transport/index.js";
import { log } from "./util.js";

export interface CreateServerOptions {
  transport?: "stdio" | "http";
  emitter?: Emitter;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Create and configure the MCP server with all registered tools.
 */
export function createServer(
  config: AzsClientConfig,
  options: CreateServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "azs-sports-analytics",
    version: PACKAGE_VERSION,
  });
  const transportKind = options.transport ?? "stdio";
  const activeEmitter =
    options.emitter ?? createEmitter({ transport: transportKind });
  const allowlistCache = new AllowlistCache();

  // Middleware order: trace first, map errors outside observability, identity before event emission.
  const pipeline = composeMiddleware([
    attachTraceId,
    mapError,
    identityMiddleware(config),
    emitObservability,
  ]);

  for (const tool of tools) {
    const leaf: ToolHandler = async (ctx, input) => {
      await assertToolAllowed(ctx.client, allowlistCache, tool.name);
      // biome-ignore lint/suspicious/noExplicitAny: ToolHandler input is unknown; tool.handler typing erased through registry.
      const text = await tool.handler(ctx, input as any);
      return { content: [mcpTextContent(text)] };
    };

    const wrapped = pipeline(leaf);

    server.tool(
      tool.name,
      tool.description,
      tool.params,
      async (input: unknown, extra: ToolExtra) => {
        const ctx: MiddlewareContext = {
          // identityMiddleware binds the per-request client and identity before any leaf handler runs.
          client: undefined as unknown as AzsClient,
          identity: undefined as unknown as Identity,
          // trace_id is set by attachTraceId middleware before mapError runs.
          trace_id: "pending",
          emit: activeEmitter.emit.bind(activeEmitter),
          current_tool: tool.name,
          transport: transportKind,
          upstream_status: null,
          client_id: null,
          error_code: null,
          request_info: extra.requestInfo,
          forwarded_headers: forwardedHeadersFromRequestInfo(extra.requestInfo),
        };
        return wrapped(ctx, input);
      },
    );
  }

  wireToolsListAllowlist(server, config, transportKind, allowlistCache);

  return server;
}

export function filterToolDefinitionsByAllowlist(
  toolDefinitions: readonly McpToolDefinition[],
  allowlistedToolNames: readonly string[],
): McpToolDefinition[] {
  const toolByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  return allowlistedToolNames
    .map((toolName) => toolByName.get(toolName))
    .filter((tool): tool is McpToolDefinition => tool !== undefined);
}

function wireToolsListAllowlist(
  server: McpServer,
  config: AzsClientConfig,
  transportKind: "stdio" | "http",
  allowlistCache: AllowlistCache,
): void {
  const toolDefinitions = buildToolDefinitions();
  let sessionClient: AzsClient | null = null;

  const getSessionClient = () => {
    if (!sessionClient) {
      sessionClient = new AzsClient(
        config,
        resolveIdentity(),
        undefined,
        resolveClientId(),
      );
    }
    return sessionClient;
  };

  server.server.registerCapabilities({
    tools: {
      listChanged: true,
    },
  });
  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request, extra) => {
      if (transportKind === "http") {
        if (!extra.requestInfo) {
          throw new Error("HTTP tools/list request missing requestInfo.");
        }
        const client = new AzsClient(
          config,
          resolveIdentityFromAuthorizationHeader(
            extra.requestInfo.headers.authorization,
          ),
          undefined,
          resolveClientId(),
          undefined,
          forwardedHeadersFromRequestInfo(extra.requestInfo),
        );
        const allowlist = await getAllowlistForClient(client, allowlistCache);

        if (!allowlist) {
          return { tools: [] };
        }

        return {
          tools: filterToolDefinitionsByAllowlist(
            toolDefinitions,
            allowlist.tools,
          ),
        } satisfies ListToolsResult;
      }

      const client = getSessionClient();
      const allowlist = await getAllowlistForClient(client, allowlistCache);

      if (!allowlist) {
        return { tools: [] };
      }

      return {
        tools: filterToolDefinitionsByAllowlist(
          toolDefinitions,
          allowlist.tools,
        ),
      } satisfies ListToolsResult;
    },
  );
}

function buildToolDefinitions(): McpToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchemaCompat(objectFromShape(tool.params), {
      strictUnions: true,
      pipeStrategy: "input",
    }) as McpToolDefinition["inputSchema"],
    execution: { taskSupport: "forbidden" },
  }));
}

/**
 * Start the MCP server on stdio transport.
 */
export async function runServe(_args: string[] = []): Promise<number> {
  const serve = parseServeArgs(_args, process.env);
  const config = loadConfig();
  if (serve.mode === "stdio") {
    resolveIdentity();
  }
  const emitter = createEmitter({ transport: serve.mode });
  const server = createServer(config, { transport: serve.mode, emitter });
  const transport = createTransport(serve, {
    config,
    emitter,
    clientId: resolveClientId(),
    createServer: (requestEmitter = emitter) =>
      createServer(config, { transport: "http", emitter: requestEmitter }),
  });

  // log only server name at info level; URL only at debug level
  log("info", `Starting AZS MCP server (${transport.kind})`);
  log("debug", `API base URL: ${config.baseUrl}`);

  // clean shutdown on SIGINT/SIGTERM
  const shutdown = () => {
    log("info", "Shutting down AZS MCP server");
    transport
      .shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await transport.start(server);
  return new Promise<number>(() => {
    // Long-running serve commands exit through the signal shutdown handlers.
  });
}

export const COMMAND_REGISTRY: readonly Command[] = [
  {
    name: "serve",
    summary: "Start the stdio MCP server (default)",
    run: runServe,
  },
  {
    name: "login",
    summary: "Authenticate with AlphaZede Sports",
    run: runLogin,
  },
  {
    name: "whoami",
    summary: "Show the current token identity and tool access",
    run: runWhoami,
  },
  {
    name: "logout",
    summary: "Delete the stored token",
    run: runLogout,
  },
  {
    name: "usage",
    summary: "Show usage information",
    run: runUsage,
  },
];

export function printHelp(): void {
  writeCliStdout(helpText(COMMAND_REGISTRY));
}

/**
 * Main entry point -- dispatch CLI subcommands.
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const result = await dispatch(COMMAND_REGISTRY, argv);
  process.exit(result.exitCode);
}

export function isMainModule(
  metaUrl: string,
  argvPath = process.argv[1],
): boolean {
  if (!argvPath) {
    return false;
  }
  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return modulePath === argvPath;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    writeCliStderr(
      `Fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
