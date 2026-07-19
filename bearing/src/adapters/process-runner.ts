import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "./adapters.js";

const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 64 * 1024;

type SpawnPort = (executable: string, args: readonly string[], options: {
  readonly cwd: string;
  readonly shell: false;
  readonly detached: true;
  readonly stdio: ["pipe", "pipe", "pipe"];
}) => ChildProcessWithoutNullStreams;
type ResolvePort = (executable: string, cwd: string) => { executable: string; cwd: string } | undefined;

function available(executable: string): boolean {
  const candidates = executable.includes("/") ? [executable] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, executable));
  return candidates.some((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
}

function resolveSpawn(executable: string, cwd: string): { executable: string; cwd: string } | undefined {
  try {
    const canonicalCwd = realpathSync(cwd);
    if (!statSync(canonicalCwd).isDirectory() || canonicalCwd !== cwd) return undefined;
    const candidates = isAbsolute(executable) ? [executable] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, executable));
    for (const candidate of candidates) {
      try {
        accessSync(candidate, constants.X_OK);
        const resolved = realpathSync(candidate);
        const relation = relative(canonicalCwd, resolved);
        if (relation && !relation.startsWith("..") && !isAbsolute(relation)) continue;
        return { executable: resolved, cwd: canonicalCwd };
      } catch { /* try the next PATH entry */ }
    }
  } catch { /* fail closed */ }
  return undefined;
}

function signal(child: ChildProcessWithoutNullStreams, kind: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, kind); return; } catch { /* child may already be gone */ }
  }
  try { child.kill(kind); } catch { /* child may already be gone */ }
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  let closed = false;
  child.once("close", () => { closed = true; });
  signal(child, "SIGTERM");
  const force = setTimeout(() => { if (!closed) signal(child, "SIGKILL"); }, 250);
  force.unref();
}

function tokenUsage(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const usage = typeof record.usage === "object" && record.usage !== null ? record.usage as Record<string, unknown> : record;
  const direct = usage.tokens ?? usage.total_tokens ?? usage.totalTokens;
  if (Number.isSafeInteger(direct) && (direct as number) >= 0) return direct as number;
  const parts = [usage.input_tokens, usage.output_tokens].filter((entry): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0);
  if (parts.length) return parts.reduce((sum, entry) => sum + entry, 0);
  return Number.isSafeInteger(usage.cached_input_tokens) && (usage.cached_input_tokens as number) >= 0 ? usage.cached_input_tokens as number : undefined;
}

const SECRET = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/gi;
const EVENT_DATA_KEYS = new Set(["id", "name", "message", "text", "content", "status", "summary", "detail", "result", "tool"]);
function safe(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET, "[redacted]").slice(0, 16_384);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => safe(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 64).flatMap(([key, entry]) => EVENT_DATA_KEYS.has(key) && !/key|secret|token|credential|authorization|password/i.test(key) ? [[key, safe(entry, depth + 1)]] : []));
}

function normalize(stdout: string): { events: readonly unknown[]; usage: { tokens: number } } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let values: unknown[];
  try {
    const parsed = JSON.parse(trimmed);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try { values = trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return undefined; }
  }
  if (!values.length || values.length > 1024 || values.some((value) => typeof value !== "object" || value === null || Array.isArray(value))) return undefined;
  let tokens: number | undefined;
  const events = values.map((value) => {
    const record = value as Record<string, unknown>;
    const found = tokenUsage(record);
    if (found !== undefined) tokens = found;
    const type = typeof record.type === "string" ? record.type : typeof record.event === "string" ? record.event : "message";
    const data = record.data ?? record.message ?? record.text ?? record.content ?? record.status;
    return { type, ...(data === undefined ? {} : { data: typeof data === "object" && data !== null && !Array.isArray(data) ? safe(data) : { content: safe(data) } }) };
  });
  return tokens === undefined ? undefined : { events, usage: { tokens } };
}

function mayHaveSideEffect(stdout: string): boolean {
  return /"(?:type|event)"\s*:\s*"[^"]*(?:tool|command|exec)/i.test(stdout);
}

/** Dependency-free production process port. Raw output is discarded after normalization. */
export class NodeProcessRunner implements ProcessRunner {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly spawnProcess: SpawnPort = spawn, private readonly inspectExecutable: (executable: string) => boolean = available, private readonly resolveExecutable: ResolvePort = resolveSpawn) {}

  executableAvailable(executable: string): boolean { return this.inspectExecutable(executable); }

  cancel(runId: string): void {
    if (this.cancelled.has(runId)) return;
    this.cancelled.add(runId);
    const child = this.children.get(runId);
    if (child) terminate(child);
  }

  run(invocation: ProcessInvocation): Promise<ProcessResult> {
    if (this.cancelled.has(invocation.runId)) return Promise.resolve({ cancelled: true });
    const spawn = this.resolveExecutable(invocation.executable, invocation.cwd);
    if (!spawn) return Promise.resolve({ exitCode: 1 });
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(spawn.executable, invocation.args, { cwd: spawn.cwd, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        resolve({ exitCode: 1 });
        return;
      }
      this.children.set(invocation.runId, child);
      const stdout: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let overflow = false;
      let settled = false;
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(invocation.runId);
        resolve(result);
      };
      const captured = (): string => Buffer.concat(stdout).toString("utf8");
      const timer = setTimeout(() => { terminate(child); finish(mayHaveSideEffect(captured()) ? { unknownSideEffect: true } : { timedOut: true }); }, invocation.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || overflow) return;
        stdoutSize += chunk.length;
        if (stdoutSize > MAX_STDOUT) { overflow = true; terminate(child); return; }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled || overflow) return;
        stderrSize += chunk.length;
        if (stderrSize > MAX_STDERR) { overflow = true; terminate(child); }
      });
      child.on("error", () => finish({ exitCode: 1 }));
      child.on("close", (code) => {
        const body = captured();
        if (this.cancelled.has(invocation.runId)) { finish(mayHaveSideEffect(body) ? { unknownSideEffect: true } : { cancelled: true }); return; }
        if (overflow) { finish(mayHaveSideEffect(body) ? { unknownSideEffect: true } : { exitCode: 0, events: "oversized" }); return; }
        if (code !== 0) { finish(mayHaveSideEffect(body) ? { unknownSideEffect: true } : { exitCode: code ?? 1 }); return; }
        const parsed = normalize(body);
        if (!parsed) { finish({ unknownSideEffect: true }); return; }
        finish({ exitCode: 0, ...parsed });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(invocation.stdin);
    });
  }
}
