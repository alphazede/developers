import { randomUUID } from "node:crypto";
import { BUILTIN_ROUTES, createAgentAdapter, routeFor, type ProcessRunner, type RouteDescriptor, type RouteModelOption } from "../adapters/adapters.js";
import {
  parseAgentProfile,
  resolveRun,
  type AgentProfile,
  type ResolvedRun,
  type RunOverrides,
  type RoleProjection,
  type Selection,
} from "../profile/profile.js";

export const REASONING_LEVELS = ["default", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "thinking"] as const;

export interface RouteInspectionPort {
  executableAvailable(executable: string): boolean;
  currentSelection?(route: RouteDescriptor): { readonly model: string; readonly reasoning: string };
  modelOptions?(route: RouteDescriptor, repositoryPath?: string): readonly RouteModelOption[];
}

export interface VerificationPort {
  verify(selection: Selection, role: RoleProjection, repositoryPath: string): Promise<boolean>;
}

export class AdapterVerification implements VerificationPort {
  constructor(private readonly runner: ProcessRunner) {}
  async verify(selection: Selection, role: RoleProjection, repositoryPath: string): Promise<boolean> {
    const adapter = createAgentAdapter(selection, this.runner);
    if (!adapter) return false;
    const receipt = await adapter.execute({ runId: `readiness-${randomUUID()}`, repositoryPath, role: { ...role, authority: { ...role.authority, write: false, network: selection.provider === "agy" ? role.authority.network : false, externalAction: false }, toolAllow: role.toolAllow.filter((tool) => !/write|edit|shell|bash/i.test(tool)), sessionId: null }, task: { prompt: "Return a short structured completion confirming readiness. Do not read or write repository files." } });
    return receipt.status === "completed" && receipt.events.some((event) => /^(complete|completed|done|result|turn\.completed|agent_end|step_finish)$/i.test(event.type));
  }
}

export interface RouteInspection {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly detected: boolean;
  readonly capabilities: readonly string[];
  readonly reasoning: string;
  readonly models: readonly RouteModelOption[];
}

export type ReadinessResult =
  | {
      readonly status: "ready" | "detected";
      readonly detected: true;
      readonly verified: boolean;
      readonly run: ResolvedRun;
    }
  | {
      readonly status: "blocked";
      readonly detected: boolean;
      readonly verified: false;
      readonly code: "selection_unavailable";
      readonly repair: "choose_detected_route";
    };

const BASE_PROFILE: AgentProfile = (() => {
  const parsed = parseAgentProfile({
    schemaVersion: 1,
    agentRef: "bearing/default",
    profileRef: "bearing/default-v1",
    credentialAccountRef: "environment",
    roles: ["navigator", "explorer", "crewmate", "surveyor"],
    toolAllow: ["read", "search", "write"],
    toolDeny: ["external-action"],
    authority: { read: true, write: true, network: true, workspace: true, externalAction: false },
    enabledSkills: [],
    context: "off",
    systemPromptRef: "bearing/default",
    limits: { timeoutMs: 300_000, maxTurns: 20, maxTools: 100, maxRetries: 1, maxConcurrency: 1, maxDelegation: 2, tokenBudget: Number.MAX_SAFE_INTEGER },
    session: { persistence: "persistent", resume: "allowed", fork: "allowed" },
    structuredEvents: true,
    fallbackEnabled: false,
    isolation: "auto",
  });
  if (!parsed.ok) throw new Error("invalid built-in profile");
  return parsed.value;
})();

function descriptor(selection: Selection): RouteDescriptor | undefined {
  const route = routeFor(selection);
  return route?.reasoningLevels.includes(selection.reasoning) ? route : undefined;
}

export class ReadinessService {
  constructor(
    private readonly inspection: RouteInspectionPort,
    private readonly verification?: VerificationPort,
    private readonly overrides: RunOverrides = {},
  ) {}

  inspect(repositoryPath = process.cwd()): readonly RouteInspection[] {
    return BUILTIN_ROUTES.slice(0, 16).map((route) => {
      const detected = this.inspection.executableAvailable(route.executable);
      const current = this.inspection.currentSelection?.(route);
      const discovered = detected ? this.inspection.modelOptions?.(route, repositoryPath) ?? [] : [];
      const models = discovered.length ? discovered : [{ model: current?.model ?? route.model, label: current?.model === "*" || !current ? "Agent default" : current.model, reasoningLevels: route.reasoningLevels, defaultReasoning: route.reasoningLevels.includes(current?.reasoning ?? "") ? current!.reasoning : route.reasoningLevels[0] }];
      const selectedModel = models.find(({ model }) => model === current?.model) ?? models[0];
      return {
        id: route.id,
        provider: route.provider,
        model: selectedModel.model,
        reasoning: selectedModel.reasoningLevels.includes(current?.reasoning ?? "") ? current!.reasoning : selectedModel.defaultReasoning,
        models,
        detected,
        capabilities: route.capabilities.slice(0, 16),
      };
    });
  }

  async check(selection: Selection, repositoryPath = process.cwd()): Promise<ReadinessResult> {
    const effectiveSelection = {
      provider: this.overrides.provider ?? selection.provider,
      model: this.overrides.model ?? selection.model,
      reasoning: this.overrides.reasoning ?? selection.reasoning,
    };
    const route = descriptor(effectiveSelection);
    const detected = route ? this.inspection.executableAvailable(route.executable) : false;
    const discovered = route && detected ? this.inspection.modelOptions?.(route, repositoryPath) : undefined;
    const models = discovered?.length ? discovered : undefined;
    const selectedModel = models?.find(({ model }) => model === effectiveSelection.model);
    if (!route || !detected || (models && (!selectedModel || !selectedModel.reasoningLevels.includes(effectiveSelection.reasoning)))) {
      return { status: "blocked", detected, verified: false, code: "selection_unavailable", repair: "choose_detected_route" };
    }
    const resolved = resolveRun({ ...BASE_PROFILE, selection }, this.overrides, randomUUID());
    if (resolved.status !== "ready") {
      return { status: "blocked", detected, verified: false, code: "selection_unavailable", repair: "choose_detected_route" };
    }
    const verificationRole = resolved.value.roles.find((role) => role.role === "crewmate") ?? resolved.value.roles[0];
    const verified = this.verification ? await this.verification.verify(effectiveSelection, verificationRole, repositoryPath).catch(() => false) : false;
    return { status: verified ? "ready" : "detected", detected: true, verified, run: resolved.value };
  }
}
