import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { createAgentAdapter, type ProcessRunner } from "../adapters/adapters.js";
import type { ResolvedRun, Selection } from "../profile/profile.js";

export type JourneyStage = "set-bearings" | "gather-supplies" | "map-route" | "draft-implementation" | "execute-explorer" | "execute-expedition" | "review";
export interface OwnerAnswer { readonly question: string; readonly answer: string; }
export interface JourneyRequest {
  readonly selection: Selection;
  readonly run: ResolvedRun;
  readonly repositoryPath: string;
  readonly runId: string;
  readonly workGoal: string;
  readonly stage: JourneyStage;
  readonly priorOwnerQa: readonly OwnerAnswer[];
  readonly planDirectory?: string;
  readonly reviewPrompt?: string;
}
export type JourneyFailureCode = "input_invalid" | "selection_mismatch" | "crewmate_unavailable" | "adapter_failed" | "token_budget" | "result_missing" | "result_malformed" | "artifact_invalid";
export type JourneyResult =
  | { readonly status: "question"; readonly question: string; readonly tokens: number }
  | { readonly status: "action"; readonly summary: string; readonly artifacts: readonly string[]; readonly tokens: number }
  | { readonly status: "failure"; readonly code: JourneyFailureCode; readonly tokens: number };

const STAGE_COMMAND: Readonly<Record<JourneyStage, string>> = {
  "set-bearings": "$to-plan",
  "gather-supplies": "$grill-with-docs",
  "map-route": "$design-driven-build",
  "draft-implementation": "$to-plan",
  "execute-explorer": "$conductor-orchestrate",
  "execute-expedition": "$ultimate-loop",
  review: "native harness review (`/review` or `codex exec review`); use the Surveyor fallback only when no native reviewer is available",
};
const STAGE_BOUNDARY: Readonly<Record<JourneyStage, string>> = {
  "set-bearings": "Create or resume only the plan directory, plan-spec.md stub, and prompts directory. Do not grill, design, draft implementation.md, or implement the work. A successful action receipt must include the relative plan-spec.md path.",
  "gather-supplies": "Ask unresolved owner questions one at a time and update only the validated plan specification. Do not run design, draft implementation.md, or implement the work. When no questions remain, return an action receipt whose artifacts include the validated plan-spec.md path.",
  "map-route": "Create only design.md, seit.md, and the generated review HTML in the validated plan directory. Do not draft implementation.md or implement the work. A successful action receipt must include all three relative paths.",
  "draft-implementation": "Draft only implementation.md and any just-in-time prompt scaffolding allowed by the planning contract. Do not execute implementation slices. A successful action receipt must include the relative implementation.md path.",
  "execute-explorer": "Execute the approved implementation plan with Explorer and honor the recorded review cadence. Return only paths that actually exist.",
  "execute-expedition": "Execute the approved implementation plan with Expedition and honor the recorded review cadence. Return only paths that actually exist.",
  review: "Perform a read-only review of the integrated uncommitted work. Do not modify files. Return existing evidence paths relevant to the review.",
};
const MAX_TEXT = 4096;
const MAX_QA = 64;
const MAX_ARTIFACTS = 32;
const MAX_ENVELOPE = 16_384;

function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function pathText(value: unknown): value is string { return text(value) && !/[\\\r\n\t]/.test(value); }

function sameSelection(left: Selection, right: Selection): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoning === right.reasoning;
}

async function containedPath(root: string, value: string, directoryOnly = false): Promise<string | undefined> {
  if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value) return undefined;
  const candidate = resolve(root, value);
  const lexical = relative(root, candidate);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return undefined;
  try {
    const canonical = await realpath(candidate);
    const relation = relative(root, canonical);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
    if (directoryOnly && !(await lstat(canonical)).isDirectory()) return undefined;
    return value;
  } catch { return undefined; }
}

function validRequest(request: JourneyRequest): boolean {
  if (!isAbsolute(request.repositoryPath) || !/^[A-Za-z0-9_-]{1,128}$/.test(request.runId) || !text(request.workGoal)) return false;
  if (!(request.stage in STAGE_COMMAND) || !Array.isArray(request.priorOwnerQa) || request.priorOwnerQa.length > MAX_QA) return false;
  return (request.reviewPrompt === undefined || text(request.reviewPrompt)) && request.priorOwnerQa.every((entry) => typeof entry === "object" && entry !== null && text(entry.question) && text(entry.answer));
}

function prompt(request: JourneyRequest, planDirectory: string | undefined): string {
  const grilling = request.stage === "gather-supplies" ? " Ask exactly one owner question at a time; use prior answers and do not repeat resolved questions." : " Ask one owner question only when a decision blocks honest progress.";
  const reviewCadence = request.stage === "execute-explorer" || request.stage === "execute-expedition" ? ["Read the prior owner Q&A for the recorded Review cadence (each slice, each phase, or end) and enforce that cadence during execution. Use the harness-native reviewer when available and the read-only Surveyor fallback only when no native reviewer is available."] : [];
  return [
    "You are a bounded Bearing journey agent. Work only inside the supplied repository and existing authority.",
    `Stage: ${request.stage}. Explicitly invoke ${STAGE_COMMAND[request.stage]} for this stage.${grilling}`,
    `Stage boundary: ${STAGE_BOUNDARY[request.stage]}`,
    `Work goal: ${JSON.stringify(request.workGoal)}`,
    `The onboarding selection ${JSON.stringify(request.selection)} applies to every role and child. Do not substitute a different provider, model, or reasoning route.`,
    `Prior owner Q&A: ${JSON.stringify(request.priorOwnerQa)}`,
    ...reviewCadence,
    `Validated plan directory: ${planDirectory ? JSON.stringify(planDirectory) : "none"}`,
    ...(request.reviewPrompt ? [`Review guidance: ${JSON.stringify(request.reviewPrompt)}`] : []),
    "Do not claim completion without actual work and evidence in this agent receipt. Do not invent artifacts, routes, sessions, or authority.",
    'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"question","question":"one question"} or BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"]}.',
  ].join("\n");
}

type Envelope = { readonly kind: "question"; readonly question: string } | { readonly kind: "action"; readonly summary: string; readonly artifacts: readonly string[] };
function envelope(value: string): Envelope | "missing" | "malformed" {
  const line = value.trim().split(/\r?\n/).at(-1) ?? "";
  const prefix = "BEARING_RESULT ";
  if (!line.startsWith(prefix)) return "missing";
  const body = line.slice(prefix.length);
  if (!body || body.length > MAX_ENVELOPE) return "malformed";
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
    const record = parsed as Record<string, unknown>;
    if (record.kind === "question" && Object.keys(record).length === 2 && text(record.question)) return { kind: "question", question: record.question };
    if (record.kind === "action" && Object.keys(record).length === 3 && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length > 0 && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length) return { kind: "action", summary: record.summary, artifacts: record.artifacts as string[] };
    return "malformed";
  } catch { return "malformed"; }
}

function stageArtifactsValid(stage: JourneyStage, artifacts: readonly string[], planDirectory: string | undefined): boolean {
  const inPlan = (path: string): boolean => planDirectory !== undefined && posix.dirname(path) === planDirectory;
  const planSpec = (path: string): boolean => posix.basename(path) === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(posix.basename(path));
  const routeReview = (path: string): boolean => posix.basename(path) === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(posix.basename(path));
  if (stage === "set-bearings") return artifacts.some(planSpec);
  if (stage === "gather-supplies") return artifacts.some((path) => inPlan(path) && planSpec(path));
  if (stage === "map-route") return ["design.md", "seit.md"].every((name) => artifacts.some((path) => inPlan(path) && posix.basename(path) === name)) && artifacts.some((path) => inPlan(path) && routeReview(path));
  if (stage === "draft-implementation") return artifacts.some((path) => inPlan(path) && posix.basename(path) === "implementation.md");
  return true;
}

/** Minimal provider-neutral bridge from a selected onboarding route to one staged journey action. */
export class JourneyService {
  constructor(private readonly runner: ProcessRunner) {}

  async execute(request: JourneyRequest): Promise<JourneyResult> {
    if (!validRequest(request)) return { status: "failure", code: "input_invalid", tokens: 0 };
    let repositoryPath: string;
    try {
      repositoryPath = await realpath(request.repositoryPath);
      if (repositoryPath !== request.repositoryPath || !(await lstat(repositoryPath)).isDirectory()) throw new Error("invalid repository");
    } catch { return { status: "failure", code: "input_invalid", tokens: 0 }; }
    const planDirectory = request.planDirectory === undefined ? undefined : await containedPath(repositoryPath, request.planDirectory, true);
    if (request.planDirectory !== undefined && planDirectory === undefined) return { status: "failure", code: "input_invalid", tokens: 0 };
    const projected = request.run.roles.find((role) => request.stage === "review" ? role.role === "surveyor" && !role.authority.write : role.role === "crewmate" && role.executor && role.authority.write);
    if (!projected) return { status: "failure", code: "crewmate_unavailable", tokens: 0 };
    if (!sameSelection(request.selection, projected.selection) || request.run.roles.some((role) => !sameSelection(role.selection, request.selection))) return { status: "failure", code: "selection_mismatch", tokens: 0 };
    const taskPrompt = prompt(request, planDirectory);
    let tokens = 0;
    let events: unknown;
    if (request.stage === "review" && request.selection.provider === "codex") {
      const modelArgs = request.selection.model === "*" ? [] : ["-m", request.selection.model];
      let result;
      try { result = await this.runner.run({ routeId: "codex", executable: "codex", args: ["exec", "review", "--uncommitted", "--json", ...modelArgs, "-c", `model_reasoning_effort="${request.selection.reasoning}"`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--ephemeral"], stdin: "", cwd: repositoryPath, timeoutMs: projected.limits.timeoutMs, runId: request.runId }); }
      catch { return { status: "failure", code: "adapter_failed", tokens: 0 }; }
      if (!result.usage || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0) return { status: "failure", code: "adapter_failed", tokens: 0 };
      if (result.usage.tokens > projected.limits.tokenBudget) return { status: "failure", code: "token_budget", tokens: result.usage.tokens };
      if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.unknownSideEffect || !Array.isArray(result.events)) return { status: "failure", code: "adapter_failed", tokens: result.usage.tokens };
      tokens = result.usage.tokens;
      events = result.events;
    } else {
      const adapter = createAgentAdapter(request.selection, this.runner);
      if (!adapter) return { status: "failure", code: "crewmate_unavailable", tokens: 0 };
      let receipt;
      try { receipt = await adapter.execute({ runId: request.runId, repositoryPath, role: { ...projected, sessionId: null, authority: { ...projected.authority, network: false, externalAction: false } }, task: { prompt: taskPrompt }, ...(request.stage === "execute-expedition" ? { allowSubagents: true } : {}) }); }
      catch { return { status: "failure", code: "adapter_failed", tokens: 0 }; }
      if (receipt.status !== "completed") return { status: "failure", code: receipt.failure === "token_budget" ? "token_budget" : "adapter_failed", tokens: receipt.usage.tokens };
      tokens = receipt.usage.tokens;
      events = receipt.events;
    }
    const assistantText = (events as unknown[]).flatMap((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof (event as { data?: { content?: unknown } }).data?.content === "string" ? [(event as { data: { content: string } }).data.content] : []).at(-1);
    if (!assistantText) return { status: "failure", code: "result_missing", tokens };
    if (request.stage === "review" && request.selection.provider === "codex") {
      const summary = assistantText.trim().slice(0, MAX_TEXT).trim();
      return text(summary) ? { status: "action", summary, artifacts: [], tokens } : { status: "failure", code: "result_malformed", tokens };
    }
    const parsed = envelope(assistantText);
    if (parsed === "missing") return { status: "failure", code: "result_missing", tokens };
    if (parsed === "malformed") return { status: "failure", code: "result_malformed", tokens };
    if (parsed.kind === "question") return { status: "question", question: parsed.question, tokens };
    for (const artifact of parsed.artifacts) if (!await containedPath(repositoryPath, artifact)) return { status: "failure", code: "artifact_invalid", tokens };
    if (!stageArtifactsValid(request.stage, parsed.artifacts, planDirectory)) return { status: "failure", code: "artifact_invalid", tokens };
    return { status: "action", summary: parsed.summary, artifacts: parsed.artifacts, tokens };
  }
}
