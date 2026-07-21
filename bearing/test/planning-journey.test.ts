import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "../src/adapters/adapters.js";
import { JourneyService, type JourneyRequest, type JourneyStage } from "../src/journey/planning-journey.js";
import { parseAgentProfile, resolveRun, type ResolvedRun, type Selection } from "../src/profile/profile.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class StubRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  constructor(private readonly result: ProcessResult, private readonly available = true) {}
  executableAvailable(): boolean { return this.available; }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> { this.calls.push(invocation); return this.result; }
}

function resolved(selection: Selection): ResolvedRun {
  const parsed = parseAgentProfile({ schemaVersion: 1, agentRef: "bearing/journey", profileRef: "bearing/journey-v1", credentialAccountRef: "environment", roles: ["navigator", "explorer", "crewmate", "surveyor"], toolAllow: ["read", "search", "write"], toolDeny: ["external-action"], authority: { read: true, write: true, network: true, workspace: true, externalAction: false }, enabledSkills: [], context: "off", systemPromptRef: "bearing/journey", limits: { timeoutMs: 1000, maxTurns: 4, maxTools: 10, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 500_000 }, session: { persistence: "persistent", resume: "allowed", fork: "allowed" }, structuredEvents: true, fallbackEnabled: false, isolation: "off", selection });
  if (!parsed.ok) throw new Error(parsed.code);
  const run = resolveRun(parsed.value, {}, "journey-test");
  if (run.status !== "ready") throw new Error(run.code);
  return run.value;
}

async function request(overrides: Partial<JourneyRequest> = {}): Promise<JourneyRequest> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bearing-journey-"))); roots.push(root);
  const selection = { provider: "codex", model: "*", reasoning: "medium" };
  return { selection, run: resolved(selection), repositoryPath: root, runId: "journey-1", workGoal: "Add bounded account import", stage: "gather-supplies", priorOwnerQa: [{ question: "CSV or JSON?", answer: "CSV" }], ...overrides };
}

function completed(text: string, tokens = 5): ProcessResult {
  return { exitCode: 0, events: [{ type: "item.completed", data: { content: text } }], usage: { tokens } };
}

async function writePlanningPackage(root: string, directory = "docs/plans/import"): Promise<void> {
  const plan = "# Plan\n", design = "# Design\n", seit = "# SEIT\n";
  const implementation = "# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Import\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** medium.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n**Required lint/static-analysis.** pnpm test\n";
  const escape = (value: string) => value.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  await mkdir(join(root, directory), { recursive: true });
  await Promise.all([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation], ["review.html", `<html><body>${[plan, design, seit, implementation].map((value) => `<pre>${escape(value)}</pre>`).join("")}</body></html>`]].map(([name, content]) => writeFile(join(root, directory, name), content)));
}

describe("JourneyService", () => {
  it("latches cancellation before asynchronous validation and permits a later retry", async () => {
    const input = await request();
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Continue?"}'));
    const service = new JourneyService(runner);
    const pending = service.execute(input);
    service.cancel(input.runId);
    expect(await pending).toEqual({ status: "failure", code: "cancelled", tokens: 0 });
    expect(runner.calls).toHaveLength(0);
    expect((await service.execute(input)).status).toBe("question");
  });

  it("honors cancellation latched while the runner is returning", async () => {
    const input = await request();
    let service!: JourneyService;
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      run: async () => {
        await service.cancel(input.runId);
        return completed('BEARING_RESULT {"kind":"question","question":"Continue?"}');
      },
      cancel: async () => undefined,
    };
    service = new JourneyService(runner);
    expect(await service.execute(input)).toEqual({ status: "failure", code: "cancelled", tokens: 5 });
  });

  it("returns one owner question and builds the skill-specific bounded prompt", async () => {
    const runner = new StubRunner(completed('Working notes\nBEARING_RESULT {"kind":"question","question":"Should duplicate emails be skipped or rejected?"}', 149_937));
    const result = await new JourneyService(runner).execute(await request());
    expect(result).toEqual({ status: "question", question: "Should duplicate emails be skipped or rejected?", tokens: 149_937 });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ routeId: "codex", executable: "codex" });
    expect(runner.calls[0].args).toContain("workspace-write");
    expect(runner.calls[0].args).not.toContain("unsupported_policy");
    expect(runner.calls[0].stdin).toMatch(/\$grill-with-docs|one owner question at a time|update only the validated plan specification|BEARING_RESULT/);
    expect(runner.calls[0].stdin).toContain('"answer":"CSV"');
    expect(runner.calls[0].stdin).toContain('The onboarding selection {"provider":"codex","model":"*","reasoning":"medium"} applies to every role and child.');
    expect(runner.calls[0].stdin).toContain("Do not substitute a different provider, model, or reasoning route.");
  });

  it("discovers every grilling question in one read-only call and appends the final check", async () => {
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"questions","questions":["Are all source files in this workspace?","Are there reference documents I should use?"]}', 21));
    const result = await new JourneyService(runner).execute(await request({ priorOwnerQa: [], gatherMode: "questions" }));
    expect(result).toEqual({ status: "question", question: "Are all source files in this workspace?", questions: ["Are all source files in this workspace?", "Are there reference documents I should use?", "Anything else?"], tokens: 21 });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toContain("read-only");
    expect(runner.calls[0].args).not.toContain("workspace-write");
    expect(runner.calls[0].stdin).toMatch(/return every important unresolved owner question together/i);
    expect(runner.calls[0].stdin).toMatch(/Do not create or modify files during question discovery/i);
  });

  it("accepts a large valid question batch and reserves capacity for prior answers and the final check", async () => {
    const longQuestions = Array.from({ length: 4 }, (_, index) => `${index}:`.padEnd(4095, "x") + "?");
    const runner = new StubRunner(completed(`BEARING_RESULT ${JSON.stringify({ kind: "questions", questions: longQuestions })}`));
    const result = await new JourneyService(runner).execute(await request({ gatherMode: "questions" }));
    expect(result).toMatchObject({ status: "question", questions: [...longQuestions, "Anything else?"] });
    expect(runner.calls[0].stdin).toContain("Return at most 60 questions");

    const overCapacity = Array.from({ length: 61 }, (_, index) => `Question ${index}?`);
    const rejected = new StubRunner(completed(`BEARING_RESULT ${JSON.stringify({ kind: "questions", questions: overCapacity })}`));
    expect(await new JourneyService(rejected).execute(await request({ gatherMode: "questions" }))).toEqual({ status: "failure", code: "result_malformed", tokens: 5 });
  });

  it("does not restart grilling after the complete answer set is submitted", async () => {
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"One more thing?"}'));
    expect(await new JourneyService(runner).execute(await request({ gatherMode: "apply" }))).toEqual({ status: "failure", code: "result_malformed", tokens: 5 });
    expect(runner.calls[0].stdin).toMatch(/All grilling questions are answered/i);
  });

  it("enables Grok subagents for Expedition only", async () => {
    const selection = { provider: "grok", model: "grok-build", reasoning: "medium" };
    const expeditionRunner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Proceed with both lanes?"}'));
    expect((await new JourneyService(expeditionRunner).execute(await request({ stage: "execute-expedition", selection, run: resolved(selection) }))).status).toBe("question");
    expect(expeditionRunner.calls[0].args.slice(0, 2)).toEqual(["--allow-subagents", "--"]);
    expect(expeditionRunner.calls[0].args).not.toContain("--no-subagents");
    expect(expeditionRunner.calls[0].stdin).toContain('{"provider":"grok","model":"grok-build","reasoning":"medium"}');
    expect(expeditionRunner.calls[0].stdin).toMatch(/recorded Review cadence \(each slice, each phase, or end\).*enforce that cadence/);
    expect(expeditionRunner.calls[0].stdin).toMatch(/harness-native reviewer.*Surveyor fallback/);

    const normalRunner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Any constraints?"}'));
    expect((await new JourneyService(normalRunner).execute(await request({ stage: "gather-supplies", selection, run: resolved(selection) }))).status).toBe("question");
    expect(normalRunner.calls[0].args[0]).toBe("--");
    expect(normalRunner.calls[0].args).toContain("--no-subagents");
    expect(normalRunner.calls[0].args).not.toContain("--allow-subagents");
  });

  it("preserves Agy's required online authority during the actual journey", async () => {
    const selection = { provider: "agy", model: "Gemini 3.5 Flash (Medium)", reasoning: "medium" };
    const run = resolved(selection);
    const unlimited = { ...run, roles: run.roles.map((role) => ({ ...role, limits: { ...role.limits, tokenBudget: Number.MAX_SAFE_INTEGER } })) };
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Continue?"}', 0));
    expect((await new JourneyService(runner).execute(await request({ selection, run: unlimited }))).status).toBe("question");
    expect(runner.calls[0].args).toEqual(expect.arrayContaining(["--sandbox", "--add-dir", "__BEARING_PROMPT_DIR__"]));
    expect(runner.calls[0].args).not.toContain("--dangerously-skip-permissions");
  });

  it("covers every stage with its existing skill or command", async () => {
    const commands = { "set-bearings": "$to-plan", "gather-supplies": "$grill-with-docs", "map-route": "$design-driven-build", "draft-implementation": "$to-plan", "execute-explorer": "$conductor-orchestrate", "execute-expedition": "$ultimate-loop" } as const;
    for (const [stage, command] of Object.entries(commands) as [Exclude<JourneyStage, "review">, string][]) {
      const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Continue?"}'));
      expect((await new JourneyService(runner).execute(await request({ stage }))).status).toBe("question");
      expect(runner.calls[0].stdin).toContain(command);
    }
  });

  it("uses an ephemeral cloned Surveyor for review and never invokes gate-review", async () => {
    const runner = new StubRunner(completed("No findings."));
    expect(await new JourneyService(runner).execute(await request({ stage: "review" }))).toEqual({ status: "action", summary: "No findings.", artifacts: [], tokens: 5 });
    expect(runner.calls[0].args).toEqual(["exec", "review", "--uncommitted", "--json", "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--ephemeral"]);
    expect(runner.calls[0].args).not.toContain("workspace-write");
    expect(runner.calls[0].stdin).toBe("");
    expect(runner.calls[0].stdin).not.toContain("gate-review");
  });

  it("uses the read-only Surveyor fallback for a harness without native review", async () => {
    const selection = { provider: "grok", model: "grok-build", reasoning: "medium" };
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Should this finding block release?"}'));
    expect((await new JourneyService(runner).execute(await request({ stage: "review", selection, run: resolved(selection), reviewPrompt: "Focus on authentication boundaries." }))).status).toBe("question");
    expect(runner.calls[0].args).toEqual(expect.arrayContaining(["--tools", "read", "--sandbox", "strict"]));
    expect(runner.calls[0].args).toContain("--disable-web-search");
    expect(runner.calls[0].args.join(" ")).not.toMatch(/write|edit/);
    expect(runner.calls[0].stdin).toContain("Focus on authentication boundaries.");
  });

  it("returns a completed action only for contained existing artifacts", async () => {
    const input = await request({ stage: "draft-implementation", planDirectory: "docs/plans/import" });
    await writePlanningPackage(input.repositoryPath);
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Implementation plan drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"]}', 11));
    expect(await new JourneyService(runner).execute(input)).toEqual({ status: "action", summary: "Implementation plan drafted.", artifacts: ["docs/plans/import/implementation.md", "docs/plans/import/review.html"], tokens: 11, planningReview: { phases: 1, slices: 1, assignments: [{ slice: "Slice 1.1 — Import", role: "Backend Engineer", model: "Codex agent default", reasoning: "medium" }] } });
    expect(runner.calls[0].stdin).toContain("docs/plans/import");
    expect(runner.calls[0].stdin).toMatch(/Regenerate the existing review HTML.*implementation\.md/);
    expect(runner.calls[0].stdin).toContain("do not use standard gate or gate-review");
  });

  it("rejects an implementation package that omits assignments or the complete embedded sources", async () => {
    const input = await request({ stage: "draft-implementation", planDirectory: "docs/plans/import" });
    await writePlanningPackage(input.repositoryPath);
    await writeFile(join(input.repositoryPath, "docs/plans/import/implementation.md"), "# Implementation\n\n### Slice 1.1 — Missing staff\n");
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"]}', 12));
    expect(await new JourneyService(runner).execute(input)).toEqual({ status: "failure", code: "artifact_invalid", tokens: 12 });
  });

  it("requires each planning action to prove its stage artifacts", async () => {
    const cases: readonly [JourneyStage, string | undefined, readonly string[]][] = [
      ["set-bearings", undefined, ["docs/plans/import/notes.md"]],
      ["gather-supplies", "docs/plans/import", ["docs/plans/import/notes.md"]],
      ["map-route", "docs/plans/import", ["docs/plans/import/design.md", "docs/plans/import/seit.md"]],
      ["draft-implementation", "docs/plans/import", ["docs/plans/import/notes.md"]],
    ];
    for (const [stage, planDirectory, artifacts] of cases) {
      const input = await request({ stage, ...(planDirectory ? { planDirectory } : {}) });
      await mkdir(join(input.repositoryPath, "docs/plans/import"), { recursive: true });
      for (const artifact of artifacts) await writeFile(join(input.repositoryPath, artifact), "evidence\n");
      const runner = new StubRunner(completed(`BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Done.", artifacts })}`, 9));
      expect(await new JourneyService(runner).execute(input)).toEqual({ status: "failure", code: "artifact_invalid", tokens: 9 });
    }
  });

  it("accepts future route-map and route-review artifact names", async () => {
    const setInput = await request({ stage: "set-bearings" });
    await mkdir(join(setInput.repositoryPath, "docs/plans/import"), { recursive: true });
    await writeFile(join(setInput.repositoryPath, "docs/plans/import/import-route-map.md"), "# Route\n");
    const setRunner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Bearings set.","artifacts":["docs/plans/import/import-route-map.md"]}'));
    expect((await new JourneyService(setRunner).execute(setInput)).status).toBe("action");

    const mapInput = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    await mkdir(join(mapInput.repositoryPath, "docs/plans/import"), { recursive: true });
    for (const name of ["design.md", "seit.md", "import-route-review.html"]) await writeFile(join(mapInput.repositoryPath, "docs/plans/import", name), "evidence\n");
    const mapRunner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Route mapped.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/import-route-review.html"]}'));
    expect((await new JourneyService(mapRunner).execute(mapInput)).status).toBe("action");
  });

  it("fails closed for missing or malformed result envelopes", async () => {
    const missing = new StubRunner(completed("Finished without an envelope", 3));
    expect(await new JourneyService(missing).execute(await request())).toEqual({ status: "failure", code: "result_missing", tokens: 3 });
    const malformed = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Done","artifacts":"not-an-array"}', 4));
    expect(await new JourneyService(malformed).execute(await request())).toEqual({ status: "failure", code: "result_malformed", tokens: 4 });
  });

  it("rejects traversal and symlink escapes even when the reported artifact exists", async () => {
    const input = await request();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "bearing-journey-outside-"))); roots.push(outside);
    await writeFile(join(outside, "escape.md"), "outside\n");
    await symlink(join(outside, "escape.md"), join(input.repositoryPath, "escape.md"));
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Done","artifacts":["escape.md"]}', 6));
    expect(await new JourneyService(runner).execute(input)).toEqual({ status: "failure", code: "artifact_invalid", tokens: 6 });

    const traversal = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Done","artifacts":["../escape.md"]}', 8));
    expect(await new JourneyService(traversal).execute(input)).toEqual({ status: "failure", code: "artifact_invalid", tokens: 8 });
  });

  it("reports adapter failure without claiming an action", async () => {
    const runner = new StubRunner({ exitCode: 1 });
    expect(await new JourneyService(runner).execute(await request({ stage: "execute-explorer" }))).toEqual({ status: "failure", code: "adapter_failed", tokens: 0 });
  });

  it("reports token-budget failure distinctly for adapter and native review paths", async () => {
    const adapterRunner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Continue?"}', 500_001));
    expect(await new JourneyService(adapterRunner).execute(await request())).toEqual({ status: "failure", code: "token_budget", tokens: 500_001 });

    const reviewRunner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Block release?"}', 500_001));
    expect(await new JourneyService(reviewRunner).execute(await request({ stage: "review" }))).toEqual({ status: "failure", code: "token_budget", tokens: 500_001 });
  });
});
