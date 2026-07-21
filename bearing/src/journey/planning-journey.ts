import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { createAgentAdapter, type ProcessActivity, type ProcessRunner } from "../adapters/adapters.js";
import type { ResolvedRun, Selection } from "../profile/profile.js";
import { setBearingsWorkspace } from "./repository-map.js";

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
  readonly gatherMode?: "questions" | "apply";
  readonly planDirectory?: string;
  readonly reviewPrompt?: string;
}
export type JourneyFailureCode = "input_invalid" | "selection_mismatch" | "crewmate_unavailable" | "adapter_failed" | "cancelled" | "interrupted" | "token_budget" | "result_missing" | "result_malformed" | "artifact_invalid";
export interface PlanningAssignment {
  readonly slice: string;
  readonly role: string;
  readonly model: string;
  readonly reasoning: string;
}
export interface PlanningReview {
  readonly phases: number;
  readonly slices: number;
  readonly assignments: readonly PlanningAssignment[];
}
export interface JourneyActivity {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly kind: string;
  readonly status?: string;
  readonly tool?: string;
}
export type JourneyResult =
  | { readonly status: "question"; readonly question: string; readonly questions?: readonly string[]; readonly tokens: number }
  | { readonly status: "action"; readonly summary: string; readonly artifacts: readonly string[]; readonly tokens: number; readonly planningReview?: PlanningReview }
  | { readonly status: "failure"; readonly code: JourneyFailureCode; readonly tokens: number };

const STAGE_COMMAND: Readonly<Record<JourneyStage, string>> = {
  "set-bearings": "$to-plan",
  "gather-supplies": "$grill-with-docs",
  "map-route": "$design-driven-build first, then $to-plan",
  "draft-implementation": "$to-plan",
  "execute-explorer": "$conductor-orchestrate",
  "execute-expedition": "$ultimate-loop",
  review: "native harness review (`/review` or `codex exec review`); use the Surveyor fallback only when no native reviewer is available",
};
const STAGE_BOUNDARY: Readonly<Record<JourneyStage, string>> = {
  "set-bearings": "Create or resume only the plan directory, plan-spec.md stub, prompts directory, and repository map. Do not grill, design, draft implementation.md, or implement the work.",
  "gather-supplies": "Use the complete owner Q&A and update only the validated plan specification. Do not run design, draft implementation.md, or implement the work. Return an action receipt whose artifacts include the validated plan-spec.md path.",
  "map-route": "Explicitly invoke $design-driven-build first. Produce valid complete or amended design.md and seit.md, including Use Cases and Communication Flows, Interface Option Check, OOPDSA Implementation Design, SEIT per-slice verification, and cross-cutting checks. Only after those gates pass, explicitly invoke $to-plan to draft implementation.md and regenerate review.html. Do not execute implementation. A successful action receipt must include design.md, seit.md, implementation.md, and review.html in the validated plan directory.",
  "draft-implementation": "Draft implementation.md without executing any slice. Every slice must name its Implementation role, the exact onboarding Agent model route, its Agent reasoning level, Ponytail mode, Required lint/static-analysis, and Review path. The Review path must use the harness-native reviewer when available or the Surveyor fallback when unavailable; do not use standard gate or gate-review. Regenerate the existing review HTML so it embeds the complete route map or plan specification, design.md, seit.md, and implementation.md. A successful action receipt must include both implementation.md and the regenerated review HTML.",
  "execute-explorer": "Execute the approved implementation plan with Explorer and honor the recorded review cadence. Return only paths that actually exist.",
  "execute-expedition": "Execute the approved implementation plan with Expedition and honor the recorded review cadence. Return only paths that actually exist.",
  review: "Perform a read-only review of the integrated uncommitted work. Do not modify files. Return existing evidence paths relevant to the review.",
};
const MAX_TEXT = 4096;
const MAX_QA = 64;
const RESERVED_POST_PLAN_QA = 2;
const MAX_ARTIFACTS = 32;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_ACTIVITY_TRAIL = 20;
const SAFE_ACTIVITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET_ACTIVITY = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/i;

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
  if (request.gatherMode === "questions" && request.priorOwnerQa.length >= MAX_QA - RESERVED_POST_PLAN_QA) return false;
  return (request.gatherMode === undefined || request.stage === "gather-supplies") &&
    (request.reviewPrompt === undefined || text(request.reviewPrompt)) && request.priorOwnerQa.every((entry) => typeof entry === "object" && entry !== null && text(entry.question) && text(entry.answer));
}

function prompt(request: JourneyRequest, planDirectory: string | undefined): string {
  const gatheringQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions";
  const availableQuestions = Math.max(0, MAX_QA - RESERVED_POST_PLAN_QA - request.priorOwnerQa.length - 1);
  const grilling = gatheringQuestions
    ? ` Inspect the repository once and return every important unresolved owner question together, in a useful order. Return at most ${availableQuestions} questions; group closely related decisions if needed. Do not include the final Anything else question; Bearing adds it.`
    : request.stage === "gather-supplies"
      ? " All grilling questions are answered. Apply the complete owner Q&A without asking another question; record reasonable assumptions or blockers in the plan specification."
      : " Ask one owner question only when a decision blocks honest progress.";
  const boundary = gatheringQuestions ? "Read and inspect only. Do not create or modify files during question discovery." : STAGE_BOUNDARY[request.stage];
  const reviewCadence = request.stage === "execute-explorer" || request.stage === "execute-expedition" ? ["Read the prior owner Q&A for the recorded Review cadence (each slice, each phase, or end) and enforce that cadence during execution. Use the harness-native reviewer when available and the read-only Surveyor fallback only when no native reviewer is available."] : [];
  return [
    "You are a bounded Bearing journey agent. Work only inside the supplied repository and existing authority.",
    `Stage: ${request.stage}. Explicitly invoke ${STAGE_COMMAND[request.stage]} for this stage.${grilling}`,
    `Stage boundary: ${boundary}`,
    `Work goal: ${JSON.stringify(request.workGoal)}`,
    `The onboarding selection ${JSON.stringify(request.selection)} applies to every role and child. Do not substitute a different provider, model, or reasoning route.`,
    `Prior owner Q&A: ${JSON.stringify(request.priorOwnerQa)}`,
    ...reviewCadence,
    `Validated plan directory: ${planDirectory ? JSON.stringify(planDirectory) : "none"}`,
    ...(planDirectory && request.stage !== "set-bearings" ? [`Repository map: ${JSON.stringify(`${planDirectory}/prompts/repository-map.md`)}. Reuse this bounded inventory before rediscovering the repository; perform only bounded live verification when necessary.`] : []),
    ...(request.reviewPrompt ? [`Review guidance: ${JSON.stringify(request.reviewPrompt)}`] : []),
    "Do not claim completion without actual work and evidence in this agent receipt. Do not invent artifacts, routes, sessions, or authority.",
    gatheringQuestions
      ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"questions","questions":["first question","second question"]}. Use an empty array when no owner decisions are needed.'
      : request.stage === "gather-supplies" && request.gatherMode === "apply"
        ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"]}.'
        : 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"question","question":"one blocking question"} or BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"]}.',
  ].join("\n");
}

type Envelope = { readonly kind: "question"; readonly question: string } | { readonly kind: "questions"; readonly questions: readonly string[] } | { readonly kind: "action"; readonly summary: string; readonly artifacts: readonly string[] };
function envelope(value: string, maxQuestions = MAX_QA - 1): Envelope | "missing" | "malformed" {
  const line = value.trim().split(/\r?\n/).at(-1) ?? "";
  const prefix = "BEARING_RESULT ";
  if (!line.startsWith(prefix)) return "missing";
  const body = line.slice(prefix.length);
  if (!body || Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) return "malformed";
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
    const record = parsed as Record<string, unknown>;
    if (record.kind === "question" && Object.keys(record).length === 2 && text(record.question)) return { kind: "question", question: record.question };
    if (record.kind === "questions" && Object.keys(record).length === 2 && Array.isArray(record.questions) && record.questions.length <= maxQuestions && record.questions.every((question) => text(question)) && new Set(record.questions).size === record.questions.length) return { kind: "questions", questions: record.questions as string[] };
    if (record.kind === "action" && Object.keys(record).length === 3 && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length > 0 && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length) return { kind: "action", summary: record.summary, artifacts: record.artifacts as string[] };
    return "malformed";
  } catch { return "malformed"; }
}

function stageArtifactsValid(stage: JourneyStage, artifacts: readonly string[], planDirectory: string | undefined): boolean {
  const inPlan = (path: string): boolean => planDirectory !== undefined && posix.dirname(path) === planDirectory;
  const planSpec = (path: string): boolean => posix.basename(path) === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(posix.basename(path));
  const routeReview = (path: string): boolean => posix.basename(path) === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(posix.basename(path));
  if (stage === "set-bearings") return artifacts.some(planSpec) && artifacts.some((path) => posix.basename(path) === "repository-map.md" && posix.dirname(posix.dirname(path)) === posix.dirname(artifacts.find(planSpec) ?? ""));
  if (stage === "gather-supplies") return artifacts.some((path) => inPlan(path) && planSpec(path));
  if (stage === "map-route") return ["design.md", "seit.md", "implementation.md"].every((name) => artifacts.some((path) => inPlan(path) && posix.basename(path) === name)) && artifacts.some((path) => inPlan(path) && routeReview(path));
  if (stage === "draft-implementation") return artifacts.some((path) => inPlan(path) && posix.basename(path) === "implementation.md") && artifacts.some((path) => inPlan(path) && routeReview(path));
  return true;
}

const MAX_PLANNING_ARTIFACT = 2 * 1024 * 1024;
function escaped(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function field(section: string, name: string): string | undefined {
  const match = new RegExp(`^\\*\\*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\*\\*\\s*(.+)$`, "mi").exec(section);
  return match?.[1]?.trim();
}

function completeArtifact(content: string, type: string, headings: readonly string[]): boolean {
  if (!new RegExp(`^---[\\s\\S]*^type:\\s*${type}\\s*$[\\s\\S]*^status:\\s*(?:complete|amended)\\s*$[\\s\\S]*^---\\s*$`, "mi").test(content)) return false;
  return headings.every((heading) => new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*\\S`, "mi").test(content));
}

async function planningReview(root: string, planDirectory: string | undefined, selection: Selection): Promise<PlanningReview | undefined> {
  if (!planDirectory) return undefined;
  const directory = resolve(root, planDirectory), names = await readdir(directory);
  const planName = names.find((name) => name === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(name));
  const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name));
  if (!planName || !reviewName || !names.includes("design.md") || !names.includes("seit.md") || !names.includes("implementation.md")) return undefined;
  const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
  const [plan, design, seit, implementation, review] = await Promise.all([...sourceNames, reviewName].map(async (name) => {
    const content = await readFile(resolve(directory, name), "utf8");
    if (!content.trim() || Buffer.byteLength(content) > MAX_PLANNING_ARTIFACT) throw new Error("invalid planning artifact");
    return content;
  }));
  if (!completeArtifact(design, "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !completeArtifact(seit, "seit", ["Per-slice Verification and Validation Matrix", "Cross-cutting Checks"])) return undefined;
  if (![plan, design, seit, implementation].every((source) => review.includes(escaped(source.trim())))) return undefined;

  const headings = [...implementation.matchAll(/^###\s+(Slice\b[^\r\n]*)/gmi)];
  if (!headings.length) return undefined;
  const assignments: PlanningAssignment[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index ?? 0, end = headings[index + 1]?.index ?? implementation.length;
    const section = implementation.slice(start, end);
    const role = field(section, "Implementation role"), model = field(section, "Agent model route"), reasoning = field(section, "Agent reasoning level");
    const ponytail = field(section, "Ponytail mode"), validation = field(section, "Required lint/static-analysis"), reviewPath = field(section, "Review path");
    if (!role || !model || !reasoning || !ponytail || !validation || !reviewPath) return undefined;
    const selectedRoute = selection.model === "*" ? selection.provider : selection.model;
    const normalizedReasoning = reasoning.replace(/[.!?]+$/, "").trim();
    if (!model.toLowerCase().includes(selectedRoute.toLowerCase()) || normalizedReasoning.toLowerCase() !== selection.reasoning.toLowerCase()) return undefined;
    assignments.push({ slice: headings[index][1].trim(), role, model, reasoning: normalizedReasoning });
  }
  return { phases: [...implementation.matchAll(/^##\s+Phase\b/gmi)].length, slices: assignments.length, assignments };
}

/** Minimal provider-neutral bridge from a selected onboarding route to one staged journey action. */
export class JourneyService {
  private readonly active = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private readonly activity = new Map<string, { stage: JourneyStage; nextSequence: number; trail: JourneyActivity[] }>();
  constructor(private readonly runner: ProcessRunner) {}

  cancel(runId: string): void { this.cancelled.add(runId); const processRunId = this.active.get(runId); if (processRunId) void this.runner.cancel?.(processRunId); }

  activityTrail(runId: string): readonly JourneyActivity[] {
    return (this.activity.get(runId)?.trail ?? []).map((entry) => ({ ...entry }));
  }

  private beginStage(runId: string, stage: JourneyStage): void {
    const current = this.activity.get(runId);
    if (current?.stage === stage) return;
    this.activity.set(runId, { stage, nextSequence: 1, trail: [] });
  }

  private recordActivity(runId: string, stage: JourneyStage, source: Pick<ProcessActivity, "kind" | "status" | "tool">): void {
    const current = this.activity.get(runId);
    if (!current || current.stage !== stage) return;
    const safe = (value: string | undefined): string | undefined => value && SAFE_ACTIVITY_VALUE.test(value) && !SECRET_ACTIVITY.test(value) ? value : undefined;
    const kind = safe(source.kind);
    if (!kind) return;
    const status = safe(source.status), tool = safe(source.tool);
    current.trail.push({ sequence: current.nextSequence, recordedAt: new Date().toISOString(), kind, ...(status ? { status } : {}), ...(tool ? { tool } : {}) });
    current.nextSequence += 1;
    if (current.trail.length > MAX_ACTIVITY_TRAIL) current.trail.shift();
  }

  private async executeOnce(request: JourneyRequest): Promise<JourneyResult> {
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
    this.beginStage(request.runId, request.stage);
    this.recordActivity(request.runId, request.stage, { kind: "stage.started", status: "running" });
    if (request.stage === "set-bearings") {
      if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens: 0 };
      try {
        this.recordActivity(request.runId, request.stage, { kind: "repository-map.started", status: "running" });
        const workspace = await setBearingsWorkspace(repositoryPath, request.workGoal, planDirectory);
        if (!workspace || !(await Promise.all(workspace.artifacts.map((artifact) => containedPath(repositoryPath, artifact)))).every(Boolean) || !stageArtifactsValid(request.stage, workspace.artifacts, workspace.directory) || this.cancelled.has(request.runId)) return { status: "failure", code: this.cancelled.has(request.runId) ? "cancelled" : "artifact_invalid", tokens: 0 };
        this.recordActivity(request.runId, request.stage, { kind: "workspace.ready", status: workspace.resumed ? "resumed" : "created" });
        return { status: "action", summary: workspace.resumed ? "Bearings resumed locally." : "Bearings set locally.", artifacts: workspace.artifacts, tokens: 0 };
      } catch { return { status: "failure", code: "artifact_invalid", tokens: 0 }; }
    }
    const taskPrompt = prompt(request, planDirectory);
    let tokens = 0;
    let events: unknown;
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens: 0 };
    const processRunId = `${request.runId.slice(0, 70)}-${randomUUID()}`;
    this.active.set(request.runId, processRunId);
    if (request.stage === "review" && request.selection.provider === "codex") {
      const modelArgs = request.selection.model === "*" ? [] : ["-m", request.selection.model];
      let result;
      try { result = await this.runner.run({ routeId: "codex", executable: "codex", args: ["exec", "review", "--uncommitted", "--json", ...modelArgs, "-c", `model_reasoning_effort="${request.selection.reasoning}"`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--ephemeral"], stdin: "", cwd: repositoryPath, timeoutMs: projected.limits.timeoutMs, runId: processRunId, onActivity: (activity) => this.recordActivity(request.runId, request.stage, activity) }); }
      catch { return { status: "failure", code: "adapter_failed", tokens: 0 }; }
      const reportedTokens = result.usage && Number.isSafeInteger(result.usage.tokens) && result.usage.tokens >= 0 ? result.usage.tokens : 0;
      if (this.cancelled.has(request.runId) && result.unknownSideEffect) return { status: "failure", code: "interrupted", tokens: reportedTokens };
      if (result.cancelled) return { status: "failure", code: "cancelled", tokens: reportedTokens };
      if (!result.usage || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0) return { status: "failure", code: "adapter_failed", tokens: 0 };
      if (result.usage.tokens > projected.limits.tokenBudget) return { status: "failure", code: "token_budget", tokens: result.usage.tokens };
      if (result.exitCode !== 0 || result.timedOut || result.unknownSideEffect || !Array.isArray(result.events)) return { status: "failure", code: "adapter_failed", tokens: result.usage.tokens };
      tokens = result.usage.tokens;
      events = result.events;
    } else {
      const adapter = createAgentAdapter(request.selection, this.runner);
      if (!adapter) return { status: "failure", code: "crewmate_unavailable", tokens: 0 };
      let receipt;
      const questionDiscovery = request.stage === "gather-supplies" && request.gatherMode === "questions";
      const planningSession = request.stage === "gather-supplies" || request.stage === "map-route" || request.stage === "draft-implementation";
      try { receipt = await adapter.execute({ runId: processRunId, repositoryPath, role: { ...projected, sessionId: planningSession ? projected.sessionId : null, authority: { ...projected.authority, write: questionDiscovery ? false : projected.authority.write, network: request.selection.provider === "agy", externalAction: false }, toolAllow: questionDiscovery ? projected.toolAllow.filter((tool) => !/write|edit/i.test(tool)) : projected.toolAllow }, task: { prompt: taskPrompt }, onActivity: (activity) => this.recordActivity(request.runId, request.stage, activity), ...(request.stage === "execute-expedition" ? { allowSubagents: true } : {}) }); }
      catch { return { status: "failure", code: "adapter_failed", tokens: 0 }; }
      if (receipt.status !== "completed") return { status: "failure", code: this.cancelled.has(request.runId) && (receipt.status === "blocked_reconcile" || receipt.failure === "unknown_side_effect") ? "interrupted" : receipt.failure === "token_budget" ? "token_budget" : receipt.failure === "cancelled" ? "cancelled" : "adapter_failed", tokens: receipt.usage.tokens };
      tokens = receipt.usage.tokens;
      events = receipt.events;
    }
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens };
    const assistantText = (events as unknown[]).flatMap((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof (event as { data?: { content?: unknown } }).data?.content === "string" ? [(event as { data: { content: string } }).data.content] : []).at(-1);
    if (!assistantText) return { status: "failure", code: "result_missing", tokens };
    if (request.stage === "review" && request.selection.provider === "codex") {
      const summary = assistantText.trim().slice(0, MAX_TEXT).trim();
      return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : text(summary) ? { status: "action", summary, artifacts: [], tokens } : { status: "failure", code: "result_malformed", tokens };
    }
    const availableQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions" ? MAX_QA - RESERVED_POST_PLAN_QA - request.priorOwnerQa.length - 1 : MAX_QA - 1;
    const parsed = envelope(assistantText, availableQuestions);
    if (parsed === "missing") return { status: "failure", code: "result_missing", tokens };
    if (parsed === "malformed") return { status: "failure", code: "result_malformed", tokens };
    if (parsed.kind === "questions") {
      if (request.stage !== "gather-supplies" || request.gatherMode !== "questions") return { status: "failure", code: "result_malformed", tokens };
      const questions = [...parsed.questions.filter((question) => question.toLowerCase() !== "anything else?"), "Anything else?"];
      return { status: "question", question: questions[0], questions, tokens };
    }
    if (parsed.kind === "question") return request.stage === "gather-supplies" && request.gatherMode !== undefined ? { status: "failure", code: "result_malformed", tokens } : this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : { status: "question", question: parsed.question, tokens };
    if (request.stage === "gather-supplies" && request.gatherMode === "questions") return { status: "failure", code: "result_malformed", tokens };
    for (const artifact of parsed.artifacts) {
      if (!await containedPath(repositoryPath, artifact)) return { status: "failure", code: "artifact_invalid", tokens };
      if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens };
    }
    if (!stageArtifactsValid(request.stage, parsed.artifacts, planDirectory)) return { status: "failure", code: "artifact_invalid", tokens };
    const review = request.stage === "map-route" || request.stage === "draft-implementation" ? await planningReview(repositoryPath, planDirectory, request.selection).catch(() => undefined) : undefined;
    if (this.cancelled.has(request.runId)) return { status: "failure", code: "cancelled", tokens };
    if ((request.stage === "map-route" || request.stage === "draft-implementation") && !review) return { status: "failure", code: "artifact_invalid", tokens };
    return { status: "action", summary: parsed.summary, artifacts: parsed.artifacts, tokens, ...(review ? { planningReview: review } : {}) };
  }

  async execute(request: JourneyRequest): Promise<JourneyResult> {
    try { return await this.executeOnce(request); }
    finally { this.active.delete(request.runId); this.cancelled.delete(request.runId); }
  }
}
