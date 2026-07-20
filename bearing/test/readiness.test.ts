import { describe, expect, it } from "vitest";
import { ReadinessService } from "../src/onboarding/readiness.js";

describe("readiness service", () => {
  it("inspects passively without verification or initialization", () => {
    let checks = 0;
    const service = new ReadinessService({ executableAvailable: () => { checks += 1; return true; } }, { verify: async () => { throw new Error("must not verify"); } });
    const routes = service.inspect();
    expect(routes).toHaveLength(4);
    expect(routes.every((route) => route.detected)).toBe(true);
    expect(checks).toBe(4);
  });

  it("uses one shared selection across distinct roles and distinguishes detected from verified", async () => {
    const detected = await new ReadinessService({ executableAvailable: () => true }).check({ provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" });
    expect(detected.status).toBe("detected");
    if (detected.status === "blocked") return;
    expect(detected.verified).toBe(false);
    expect(detected.run.roles.every((role) => role.limits.tokenBudget === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(new Set(detected.run.roles.map((role) => JSON.stringify(role.selection))).size).toBe(1);
    expect(new Set(detected.run.roles.map((role) => role.identity)).size).toBe(4);
    expect(new Set(detected.run.roles.map((role) => JSON.stringify(role.authority))).size).toBe(4);
    expect(new Set(detected.run.roles.map((role) => JSON.stringify({ allow: role.toolAllow, deny: role.toolDeny }))).size).toBe(4);
    expect(detected.run.roles.find((role) => role.role === "surveyor")).toMatchObject({ executor: false, authority: { write: false, network: false }, toolAllow: ["read"] });
    expect(JSON.stringify(detected)).not.toMatch(/credentialAccountRef|accounts\/|apiKey|password/i);

    const verified = await new ReadinessService({ executableAvailable: () => true }, { verify: async () => true }).check({ provider: "codex", model: "gpt-5.6-terra", reasoning: "high" });
    expect(verified.status).toBe("ready");
  });

  it("returns one stable repair code without fallback or auto-selection", async () => {
    const service = new ReadinessService({ executableAvailable: () => false });
    expect(await service.check({ provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).toEqual({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" });
    expect(await service.check({ provider: "unknown", model: "unknown", reasoning: "medium" })).toEqual({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" });
  });

  it("preserves the Codex wildcard selection for configured-model execution", async () => {
    const result = await new ReadinessService({ executableAvailable: () => true }).check({ provider: "codex", model: "*", reasoning: "medium" });
    expect(result.status).toBe("detected");
    if (result.status !== "blocked") expect(result.run.roles[0].selection).toEqual({ provider: "codex", model: "*", reasoning: "medium" });
  });

  it("applies startup overrides only while resolving the selected run", async () => {
    const result = await new ReadinessService({ executableAvailable: () => true }, undefined, { offline: true, maxTurns: 3 }).check({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" });
    expect(result.status).toBe("detected");
    if (result.status === "blocked") return;
    expect(result.run.receipt.effective).toMatchObject({ authority: { network: false }, limits: { maxTurns: 3 } });
    const routed = await new ReadinessService({ executableAvailable: (executable) => executable === "pi" }, undefined, { provider: "pi", model: "zai/glm-5.2", reasoning: "low" }).check({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" });
    expect(routed.status).toBe("detected");
    if (routed.status !== "blocked") expect(routed.run.roles[0].selection).toEqual({ provider: "pi", model: "zai/glm-5.2", reasoning: "low" });
    const lowered = await new ReadinessService({ executableAvailable: () => true }, undefined, { budget: { tokens: 120_000 } }).check({ provider: "codex", model: "*", reasoning: "medium" });
    expect(lowered.status).toBe("detected");
    if (lowered.status !== "blocked") expect(lowered.run.roles.every((role) => role.limits.tokenBudget === 120_000)).toBe(true);
  });
});
