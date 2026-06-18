import {
  attribution,
  bullet,
  formatVelocityClass,
  heading,
  separator,
} from "./format.js";
import { emitMcpContent } from "./output-sink-registry.js";

export const FORMATTER_PRIMITIVES = Object.freeze({
  heading,
  bullet,
  separator,
  attribution,
  formatVelocityClass,
});

type FormatterPrimitiveName = keyof typeof FORMATTER_PRIMITIVES;

interface FormatterPrimitiveSinkBinding {
  readonly primitive: FormatterPrimitiveName;
  readonly sinkName: "mcp.content.text";
  readonly sinkKind: "mcp-content";
}

const FORMATTER_PRIMITIVE_ORDER: readonly FormatterPrimitiveName[] =
  Object.freeze([
    "heading",
    "bullet",
    "separator",
    "attribution",
    "formatVelocityClass",
  ]);

const FORMATTER_PRIMITIVE_SINK_BINDINGS: readonly FormatterPrimitiveSinkBinding[] =
  Object.freeze(
    FORMATTER_PRIMITIVE_ORDER.map((primitive) =>
      Object.freeze({
        primitive,
        sinkName: "mcp.content.text" as const,
        sinkKind: "mcp-content" as const,
      }),
    ),
  );

export function getFormatterPrimitiveSinkBindings(): readonly FormatterPrimitiveSinkBinding[] {
  return FORMATTER_PRIMITIVE_SINK_BINDINGS;
}

export function emitFormatterPrimitiveOutput(text: string): string {
  return emitMcpContent(text);
}
