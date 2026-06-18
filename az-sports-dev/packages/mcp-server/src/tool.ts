import { z } from "zod";
import type { AzsClient } from "./client.js";

const TOOL_NAME_SCHEMA = z.string().regex(/^[a-z][a-z0-9_]*$/);

export type Identity =
  | {
      kind: "oauth";
      token: string;
    }
  | {
      kind: "api_key";
      token: string;
    }
  | {
      kind: "system";
      token: string;
    };

export interface ObsEventStart {
  event: "tool.call.start";
  ts: string;
  trace_id: string;
  tool: string;
  identity_key: string;
  client_id: string | null;
  transport: "stdio" | "http";
  params_hash: string;
}

export interface ObsEventEnd {
  event: "tool.call.end";
  ts: string;
  trace_id: string;
  tool: string;
  identity_key: string;
  client_id: string | null;
  transport: "stdio" | "http";
  latency_ms: number;
  status:
    | "ok"
    | "upstream_error"
    | "unexpected_error"
    | "quota_exceeded"
    | "auth_error";
  upstream_status: number | null;
}

export type ObsEvent = ObsEventStart | ObsEventEnd;

export interface ToolContext {
  client: AzsClient;
  identity: Identity;
  trace_id: string;
  emit: (event: ObsEvent) => void;
}

export interface Tool<P extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  params: P;
  handler: (
    ctx: ToolContext,
    input: z.infer<z.ZodObject<P>>,
  ) => Promise<string>;
}

interface SimpleToolSpec<P extends z.ZodRawShape, R> {
  name: string;
  description: string;
  params: P;
  fetch: (client: AzsClient, input: z.infer<z.ZodObject<P>>) => Promise<R>;
  format: (response: R, input: z.infer<z.ZodObject<P>>) => string;
}

export function defineTool<P extends z.ZodRawShape>(spec: {
  name: string;
  description: string;
  params: P;
  handler: (
    ctx: ToolContext,
    input: z.infer<z.ZodObject<P>>,
  ) => Promise<string>;
}): Tool<P> {
  if (!TOOL_NAME_SCHEMA.safeParse(spec.name).success) {
    throw new Error(
      `Invalid tool name: "${spec.name}". Must match /^[a-z][a-z0-9_]*$/.`,
    );
  }

  if (spec.description.trim() === "") {
    throw new Error(`Tool "${spec.name}" missing description.`);
  }

  if (
    spec.params === undefined ||
    spec.params === null ||
    typeof spec.params !== "object"
  ) {
    throw new Error(`Tool "${spec.name}" missing params shape.`);
  }

  return spec;
}

export function assertNoDuplicateToolNames(tools: readonly Tool[]): void {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const count = (counts.get(tool.name) ?? 0) + 1;
    if (count > 1) throw new Error(`Duplicate tool name: "${tool.name}".`);
    counts.set(tool.name, count);
  }
}

export function defineSimpleTool<P extends z.ZodRawShape, R>(
  spec: SimpleToolSpec<P, R>,
): Tool<P> {
  return defineTool({
    name: spec.name,
    description: spec.description,
    params: spec.params,
    handler: async (ctx, input) => {
      const response = await spec.fetch(ctx.client, input);
      return spec.format(response, input);
    },
  });
}
