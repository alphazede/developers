import { randomUUID } from "node:crypto";
import { BUILTIN_ROUTES, createAgentAdapter, routeFor, type ProcessRunner, type RouteDescriptor } from "../adapters/adapters.js";
import {
  parseAgentProfile,
  resolveRun,
  type AgentProfile,
  type ResolvedRun,
  type RunOverrides,
  type RoleProjection,
  type Selection,
} from "../profile/profile.js";

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export interface RouteInspectionPort {
  executableAvailable(executable: string): boolean;
  currentSelection?(route: RouteDescriptor): { readonly model: string; readonly reasoning: string };
}

export interface VerificationPort {
  verify(selection: Selection, role: RoleProjection, repositoryPath: string): Promise<boolean>;
}

export class AdapterVerification implements VerificationPort {
  constructor(private readonly runner: ProcessRunner) {}
  async verify(selection: Selection, role: RoleProjection, repositoryPath: string): Promise<boolean> {
    const adapter = createAgentAdapter(selection, this.runner);
    if (!adapter) return false;
    const receipt = await adapter.execute({ runId: `readiness-${randomUUID()}`, repositoryPath, role: { ...role, authority: { ...role.authority, write: false, network: false, externalAction: false }, toolAllow: role.toolAllow.filter((tool) => !/write|edit|shell|bash/i.test(tool)), sessionId: null }, task: { prompt: "Return a short structured completion confirming readiness. Do not read or write repository files." } });
    return receipt.status === "completed" && receipt.events.some((event) => /^(complete|completed|done|result|turn\.completed|agent_end)$/i.test(event.type));
  }
}

export interface RouteInspection {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly detected: boolean;
  readonly capabilities: readonly string[];
  readonly reasoning: string;
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
  if (!(REASONING_LEVELS as readonly string[]).includes(selection.reasoning)) return undefined;
  return routeFor(selection);
}

export class ReadinessService {
  constructor(
    private readonly inspection: RouteInspectionPort,
    private readonly verification?: VerificationPort,
    private readonly overrides: RunOverrides = {},
  ) {}

  inspect(): readonly RouteInspection[] {
    return BUILTIN_ROUTES.slice(0, 16).map((route) => {
      const current = this.inspection.currentSelection?.(route);
      return {
        id: route.id,
        provider: route.provider,
        model: current?.model ?? route.model,
        reasoning: current && (REASONING_LEVELS as readonly string[]).includes(current.reasoning) ? current.reasoning : "medium",
        detected: this.inspection.executableAvailable(route.executable),
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
    if (!route || !detected) {
      return { status: "blocked", detected, verified: false, code: "selection_unavailable", repair: "choose_detected_route" };
    }
    const resolved = resolveRun({ ...BASE_PROFILE, selection }, this.overrides, randomUUID());
    if (resolved.status !== "ready") {
      return { status: "blocked", detected, verified: false, code: "selection_unavailable", repair: "choose_detected_route" };
    }
    const verified = this.verification ? await this.verification.verify(effectiveSelection, resolved.value.roles[0], repositoryPath).catch(() => false) : false;
    return { status: verified ? "ready" : "detected", detected: true, verified, run: resolved.value };
  }
}
