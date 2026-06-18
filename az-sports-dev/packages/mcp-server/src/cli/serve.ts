import { parseHttpBind } from "./serve-http.js";

export type ServeOptions =
  | {
      mode: "stdio";
    }
  | {
      mode: "http";
      host: string;
      port: number;
      allowNonLoopback: boolean;
      isProduction: boolean;
    };

export function parseServeArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServeOptions {
  if (args.length === 0) {
    return { mode: "stdio" };
  }

  let httpValue: string | null = null;
  let allowNonLoopback = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--http") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--http requires :PORT or HOST:PORT format.");
      }
      httpValue = value;
      index += 1;
      continue;
    }
    if (arg === "--allow-non-loopback") {
      allowNonLoopback = true;
      continue;
    }
    throw new Error(`Unknown serve option: ${arg}`);
  }

  if (!httpValue) {
    return { mode: "stdio" };
  }

  const bind = parseHttpBind(httpValue);
  return {
    mode: "http",
    host: bind.host,
    port: bind.port,
    allowNonLoopback,
    isProduction: env.AZS_MCP_PRODUCTION === "1",
  };
}
