import * as fs from "node:fs";
import { AzsClient, loadConfig } from "./client.js";
import { resolveClientId, resolveIdentity } from "./middleware.js";
import {
  appendSerializedObsEventLineTerminator,
  serializeObsEvent,
  writeSerializedObsEventStderr,
} from "./output-sink-registry.js";
import type { ObsEvent } from "./tool.js";

export type { ObsEvent } from "./tool.js";

export interface Emitter {
  emit(event: ObsEvent): void;
  flush?(): Promise<void>;
}

export type EmitterTransport = "stdio" | "http";

export interface CreateEmitterOptions {
  transport?: EmitterTransport;
}

export class StderrEmitter implements Emitter {
  emit(event: ObsEvent): void {
    writeSerializedObsEventStderr(
      appendSerializedObsEventLineTerminator(serializeObsEvent(event)),
    );
  }
}

export class FileEmitter implements Emitter {
  readonly #filePath: string;
  #stream: fs.WriteStream | null = null;
  #pending: string[] = [];
  #drainScheduled = false;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  emit(event: ObsEvent): void {
    this.#pending.push(
      appendSerializedObsEventLineTerminator(serializeObsEvent(event)),
    );
    this.#scheduleDrain();
  }

  async flush(): Promise<void> {
    this.#drainQueue();
    if (!this.#stream) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.#stream?.write("", (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const fd = (this.#stream as fs.WriteStream & { fd?: number | null }).fd;
    if (typeof fd === "number") {
      fs.fsyncSync(fd);
    }
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) {
      return;
    }

    this.#drainScheduled = true;
    setImmediate(() => {
      this.#drainScheduled = false;
      this.#drainQueue();
    });
  }

  #drainQueue(): void {
    if (this.#pending.length === 0) {
      return;
    }

    const stream = this.#getStream();
    const lines = this.#pending.splice(0, this.#pending.length);
    for (const line of lines) {
      stream.write(line);
    }
  }

  #getStream(): fs.WriteStream {
    this.#stream ??= fs.createWriteStream(this.#filePath, { flags: "a" });
    return this.#stream;
  }
}

export class NoopEmitter implements Emitter {
  emit(_event: ObsEvent): void {}

  async flush(): Promise<void> {}
}

interface AzsClientRuntime {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export class UpstreamEmitter implements Emitter {
  static readonly maxBufferSize = 100;

  readonly #clientFactory: () => AzsClient;
  readonly #timer: ReturnType<typeof setInterval>;
  #client: AzsClient | null = null;
  #pending: ObsEvent[] = [];

  constructor(client: AzsClient | (() => AzsClient)) {
    this.#clientFactory = typeof client === "function" ? client : () => client;
    this.#timer = setInterval(() => {
      void this.flush();
    }, 5000);
    this.#timer.unref?.();
  }

  emit(event: ObsEvent): void {
    this.#pending.push(event);
    if (this.#pending.length >= UpstreamEmitter.maxBufferSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) {
      return;
    }

    const events = this.#pending.splice(0, this.#pending.length);
    try {
      this.#client ??= this.#clientFactory();
      const runtime = this.#client as unknown as Partial<AzsClientRuntime>;
      if (
        typeof runtime.baseUrl !== "string" ||
        typeof runtime.token !== "string" ||
        typeof runtime.timeoutMs !== "number"
      ) {
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
      try {
        await fetch(`${runtime.baseUrl}/api/v1/mcp/events`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${runtime.token}`,
            "Content-Type": "application/json",
          },
          body: `[${events.map((event) => serializeObsEvent(event)).join(",")}]`,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Observability must not affect the request path.
    }
  }
}

export class RequestScopedEmitter implements Emitter {
  readonly #client: AzsClient;
  #pending: ObsEvent[] = [];

  constructor(client: AzsClient) {
    this.#client = client;
  }

  emit(event: ObsEvent): void {
    this.#pending.push(event);
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) {
      return;
    }

    const events = this.#pending.splice(0, this.#pending.length);
    try {
      const runtime = this.#client.getRuntimeForAllowlist();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
      try {
        await fetch(`${runtime.baseUrl}/api/v1/mcp/events`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${runtime.token}`,
            "Content-Type": "application/json",
          },
          body: `[${events.map((event) => serializeObsEvent(event)).join(",")}]`,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Observability must not affect the request path.
    }
  }
}

export function createEmitter(options: CreateEmitterOptions = {}): Emitter {
  const transport = options.transport ?? "stdio";
  const destination = process.env.AZS_MCP_OBS_DEST;
  if (!destination || destination === "stderr") {
    return new StderrEmitter();
  }

  if (destination.startsWith("file:")) {
    return new FileEmitter(destination.slice("file:".length));
  }

  if (destination === "upstream") {
    if (transport === "http") {
      // HTTP replaces this startup placeholder per request once the
      // bearer-bound AzsClient is known; startup-scope events are dropped.
      return new NoopEmitter();
    }

    return new UpstreamEmitter(
      () =>
        new AzsClient(
          loadConfig(),
          resolveIdentity(),
          undefined,
          resolveClientId(),
        ),
    );
  }

  return new StderrEmitter();
}
