import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServeOptions } from "../cli/serve.js";
import type { AzsClientConfig } from "../client.js";
import type { Emitter } from "../observability.js";
import { type HttpTransportOptions, StreamableHttpTransport } from "./http.js";

export interface Transport {
  readonly kind: "stdio" | "http";
  start(server: McpServer): Promise<void>;
  shutdown(): Promise<void>;
}

export class StdioTransport implements Transport {
  readonly kind = "stdio" as const;
  #server: McpServer | null = null;

  async start(server: McpServer): Promise<void> {
    this.#server = server;
    const sdkTransport = new StdioServerTransport();
    await server.connect(sdkTransport);
  }

  async shutdown(): Promise<void> {
    await this.#server?.close();
    this.#server = null;
  }
}

interface TransportDeps {
  config: AzsClientConfig;
  emitter: Emitter;
  clientId: string;
  createServer?: (emitter?: Emitter) => McpServer;
}

export function createTransport(
  options: ServeOptions,
  deps: TransportDeps,
): Transport {
  if (options.mode === "stdio") {
    return new StdioTransport();
  }

  const httpOptions: HttpTransportOptions = {
    host: options.host,
    port: options.port,
    allowNonLoopback: options.allowNonLoopback,
    isProduction: options.isProduction,
  };
  return new StreamableHttpTransport(httpOptions, deps);
}
