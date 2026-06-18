import { randomBytes } from "node:crypto";
import { scrub } from "./scrubber.js";
import type { ObsEvent } from "./tool.js";

export type OutputSinkKind =
  | "mcp-content"
  | "cli-stdout"
  | "cli-stderr"
  | "obs-event-line"
  | "obs-event-field"
  | "internal-log"
  | "artifact-text";

type OutputSinkSurface = "runtime" | "artifact";
type SinkEmitter = (text: string) => void;
type SinkScrubber = (text: string) => string;

interface RegisterSinkOptions {
  name: string;
  kind: OutputSinkKind;
  surface?: OutputSinkSurface;
  scrubber?: SinkScrubber;
  emit?: SinkEmitter;
  structuredFields?: "free-form" | "constrained";
}

interface OutputSinkDescriptor {
  readonly name: string;
  readonly kind: OutputSinkKind;
  readonly surface: OutputSinkSurface;
  readonly structuredFields: "free-form" | "constrained";
}

interface RegisteredSink extends OutputSinkDescriptor {
  emit(text: string): string;
}

declare const SerializedObsEventLineBrand: unique symbol;
type SerializedObsEventLine = string & {
  readonly [SerializedObsEventLineBrand]: true;
};

interface OutputEmitSinkRegistryReadOnly {
  emitVia(name: string, text: string): string;
  getSink(name: string): RegisteredSink;
  listSinks(): readonly OutputSinkDescriptor[];
}

interface OutputEmitSinkRegistry extends OutputEmitSinkRegistryReadOnly {
  registerSink(options: RegisterSinkOptions): RegisteredSink;
  seal(): void;
}

/**
 * Runtime output sink registry for public MCP runtime paths.
 *
 * The registry centralizes string emission for MCP content, CLI
 * stdout/stderr, observability fields, and runtime logs. Free-form
 * text is scrubbed before delegation; structured observability fields
 * rely on schema constraints before serialization.
 */
class RuntimeOutputEmitSinkRegistry implements OutputEmitSinkRegistry {
  readonly #sinks = new Map<string, RegisteredSink>();
  #sealed = false;

  registerSink(options: RegisterSinkOptions): RegisteredSink {
    if (this.#sealed) {
      throw new Error("OutputEmitSinkRegistry is sealed after initialization.");
    }
    if (this.#sinks.has(options.name)) {
      throw new Error(`Output sink already registered: ${options.name}`);
    }

    const scrubber = options.scrubber ?? scrub;
    const delegate = options.emit;
    const descriptor = {
      name: options.name,
      kind: options.kind,
      surface: options.surface ?? "runtime",
      structuredFields: options.structuredFields ?? "free-form",
    } as const;
    const sink = Object.freeze({
      ...descriptor,
      emit(text: string): string {
        const scrubbed = scrubber(text);
        delegate?.(scrubbed);
        return scrubbed;
      },
    });

    this.#sinks.set(options.name, sink);
    return sink;
  }

  seal(): void {
    this.#sealed = true;
  }

  emitVia(name: string, text: string): string {
    return this.getSink(name).emit(text);
  }

  getSink(name: string): RegisteredSink {
    const sink = this.#sinks.get(name);
    if (!sink) {
      throw new Error(`Output sink is not registered: ${name}`);
    }
    return sink;
  }

  listSinks(): readonly OutputSinkDescriptor[] {
    return Object.freeze(
      [...this.#sinks.values()].map((sink) =>
        Object.freeze({
          name: sink.name,
          kind: sink.kind,
          surface: sink.surface,
          structuredFields: sink.structuredFields,
        }),
      ),
    );
  }
}

Object.freeze(RuntimeOutputEmitSinkRegistry.prototype);

export function createOutputSinkRegistry(): OutputEmitSinkRegistry {
  return new RuntimeOutputEmitSinkRegistry();
}

interface RuntimeSinks {
  mcpContent: RegisteredSink;
  cliStdout: RegisteredSink;
  cliStderr: RegisteredSink;
  obsEventField: RegisteredSink;
  obsEventStderr: RegisteredSink;
  internalLog: RegisteredSink;
}

interface ArtifactSinks {
  readme: RegisteredSink;
  serverJson: RegisteredSink;
  marketplaceIssue: RegisteredSink;
  pngMetadata: RegisteredSink;
  smitheryCard: RegisteredSink;
}

/**
 * Register runtime sinks. Future public artifact support should keep using the public registry shape.
 * `registerArtifactSinks(registry: OutputEmitSinkRegistry): void` beside this
 * function, then call both registration functions from `bootstrap()` before
 * the registry is sealed.
 */
function registerRuntimeSinks(registry: OutputEmitSinkRegistry): RuntimeSinks {
  const mcpContent = registry.registerSink({
    name: "mcp.content.text",
    kind: "mcp-content",
  });
  const cliStdout = registry.registerSink({
    name: "cli.stdout",
    kind: "cli-stdout",
    emit: (text) => process.stdout.write(text),
  });
  const cliStderr = registry.registerSink({
    name: "cli.stderr",
    kind: "cli-stderr",
    emit: (text) => process.stderr.write(text),
  });
  const obsEventField = registry.registerSink({
    name: "obs.event.field",
    kind: "obs-event-field",
  });
  const obsEventStderr = registry.registerSink({
    name: "obs.event.stderr",
    kind: "obs-event-line",
    structuredFields: "constrained",
    scrubber: identity,
    emit: (text) => process.stderr.write(text),
  });
  const internalLog = registry.registerSink({
    name: "internal.log",
    kind: "internal-log",
    scrubber: scrubInternalLog,
    emit: (text) => process.stderr.write(text),
  });

  return {
    mcpContent,
    cliStdout,
    cliStderr,
    obsEventField,
    obsEventStderr,
    internalLog,
  };
}

function registerArtifactSinks(
  registry: OutputEmitSinkRegistry,
): ArtifactSinks {
  const readme = registry.registerSink({
    name: "artifact.readme",
    kind: "artifact-text",
    surface: "artifact",
  });
  const serverJson = registry.registerSink({
    name: "artifact.server-json",
    kind: "artifact-text",
    surface: "artifact",
  });
  const marketplaceIssue = registry.registerSink({
    name: "artifact.marketplace-issue",
    kind: "artifact-text",
    surface: "artifact",
  });
  const pngMetadata = registry.registerSink({
    name: "artifact.png-metadata",
    kind: "artifact-text",
    surface: "artifact",
  });
  const smitheryCard = registry.registerSink({
    name: "artifact.smithery-card",
    kind: "artifact-text",
    surface: "artifact",
  });
  return { readme, serverJson, marketplaceIssue, pngMetadata, smitheryCard };
}

function bootstrap(): {
  registry: OutputEmitSinkRegistry;
  sinks: RuntimeSinks;
  artifactSinks: ArtifactSinks;
} {
  const registry = createOutputSinkRegistry();
  const sinks = registerRuntimeSinks(registry);
  const artifactSinks = registerArtifactSinks(registry);
  registry.seal();
  return { registry, sinks, artifactSinks };
}

const {
  registry: runtimeRegistry,
  sinks: runtimeSinks,
  artifactSinks: runtimeArtifactSinks,
} = bootstrap();

export function getRegisteredSinks(): readonly OutputSinkDescriptor[] {
  return runtimeRegistry.listSinks();
}

export function getArtifactSinks(): readonly OutputSinkDescriptor[] {
  return runtimeRegistry
    .listSinks()
    .filter((sink) => sink.surface === "artifact");
}

export function emitArtifactReadme(text: string): string {
  return runtimeArtifactSinks.readme.emit(text);
}

export function emitArtifactServerJson(text: string): string {
  return runtimeArtifactSinks.serverJson.emit(text);
}

export function emitArtifactMarketplaceIssue(text: string): string {
  return runtimeArtifactSinks.marketplaceIssue.emit(text);
}

export function emitArtifactPngMetadata(text: string): string {
  return runtimeArtifactSinks.pngMetadata.emit(text);
}

export function emitArtifactSmitheryCard(text: string): string {
  return runtimeArtifactSinks.smitheryCard.emit(text);
}

export function emitMcpContent(text: string): string {
  return runtimeSinks.mcpContent.emit(text);
}

export function mcpTextContent(text: string): { type: "text"; text: string } {
  return {
    type: "text",
    text: emitMcpContent(text),
  };
}

export function mcpTraceTextContent(
  text: string,
  traceId: string,
): { type: "text"; text: string } {
  return {
    type: "text",
    text: `${emitMcpContent(text)} (trace_id: ${traceId})`,
  };
}

export function writeCliStdout(text: string): string {
  return runtimeSinks.cliStdout.emit(text);
}

export function writeCliStderr(text: string): string {
  return runtimeSinks.cliStderr.emit(text);
}

export function writeSerializedObsEventStderr(
  line: SerializedObsEventLine,
): SerializedObsEventLine {
  return runtimeSinks.obsEventStderr.emit(line) as SerializedObsEventLine;
}

export function writeInternalLog(text: string): string {
  return runtimeSinks.internalLog.emit(text);
}

export function scrubObsEventField(field: string, value: string): string {
  if (isConstrainedObsField(field, value)) {
    return value;
  }
  return runtimeSinks.obsEventField.emit(value);
}

function sanitizeObsEvent(event: ObsEvent): ObsEvent {
  const source = event as unknown as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(source)) {
    sanitized[field] =
      typeof value === "string" ? scrubObsEventField(field, value) : value;
  }
  return sanitized as unknown as ObsEvent;
}

export function serializeObsEvent(event: ObsEvent): SerializedObsEventLine {
  return JSON.stringify(sanitizeObsEvent(event)) as SerializedObsEventLine;
}

export function appendSerializedObsEventLineTerminator(
  line: SerializedObsEventLine,
): SerializedObsEventLine {
  return `${line}\n` as SerializedObsEventLine;
}

function identity(text: string): string {
  return text;
}

function scrubInternalLog(text: string): string {
  const nonce = randomBytes(8).toString("hex");
  const placeholderFor = (index: number) =>
    `__AZS_TRACE_ID_${nonce}_${index}__`;
  const preservedTraceIds: string[] = [];
  const protectedText = text.replace(
    /\btrace_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|unknown)\b/gi,
    (match) => {
      const placeholder = placeholderFor(preservedTraceIds.length);
      preservedTraceIds.push(match);
      return placeholder;
    },
  );
  const scrubbed = scrub(protectedText);
  return preservedTraceIds.reduce(
    (restored, traceId, index) =>
      restored.replace(placeholderFor(index), traceId),
    scrubbed,
  );
}

function isConstrainedObsField(field: string, value: string): boolean {
  switch (field) {
    case "event":
      return value === "tool.call.start" || value === "tool.call.end";
    case "tool":
      return /^[a-z][a-z0-9_]*$/.test(value);
    case "client_id":
      return /^azs-(claude|cursor|codex|gemini)-mcp$/.test(value);
    case "transport":
      return value === "stdio" || value === "http";
    case "status":
      return /^(ok|upstream_error|unexpected_error|quota_exceeded|auth_error)$/.test(
        value,
      );
    case "params_hash":
    case "identity_key":
      return /^[0-9a-f]{64}$/i.test(value);
    case "trace_id":
      return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
    case "ts":
      return !Number.isNaN(Date.parse(value));
    default:
      return false;
  }
}
