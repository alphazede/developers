import { PACKAGE_VERSION } from "../client.js";
import { writeCliStderr, writeCliStdout } from "../output-sink-registry.js";

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly run: (args: string[]) => Promise<number>;
}

interface DispatchResult {
  readonly exitCode: number;
}

export async function dispatch(
  registry: readonly Command[],
  argv: string[],
): Promise<DispatchResult> {
  const subcommand = argv[0] ?? "serve";
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    writeCliStdout(helpText(registry));
    return { exitCode: 0 };
  }

  const command = registry.find((entry) => entry.name === subcommand);
  if (!command) {
    return unknownCommandResult(subcommand);
  }

  const exitCode = await command.run(argv.slice(1));
  return { exitCode };
}

export function helpText(registry: readonly Command[]): string {
  // Keep "serve" Use: continuation lines aligned even if every command is shorter.
  const nameWidth = Math.max(
    7,
    ...registry.map((command) => command.name.length),
  );
  const commandLines = registry
    .map((command) => {
      const line = `  ${command.name.padEnd(nameWidth)}  ${command.summary}`;
      if (command.name !== "serve") {
        return line;
      }
      return `${line}
${" ".repeat(nameWidth + 2)}Use: serve --http <bind-address> [--allow-non-loopback]`;
    })
    .join("\n");

  return `azs-mcp-server v${PACKAGE_VERSION}

Usage: azs-mcp-server [command]

Commands:
${commandLines}
  ${"help".padEnd(nameWidth)}  Show this help message
`;
}

function unknownCommandResult(name: string): DispatchResult {
  writeCliStderr(
    `Unknown subcommand: ${name}\nRun 'azs-mcp-server help' for usage.\n`,
  );
  return { exitCode: 2 };
}
