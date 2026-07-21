import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

class QueueRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  constructor(private readonly results: readonly ProcessResult[]) {}
  executableAvailable(): boolean { return true; }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> { this.calls.push(invocation); return this.results[this.calls.length - 1] ?? { exitCode: 1 }; }
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

const planFixture = "# Plan\n";
const designFixture = "---\ntype: design\nstatus: complete\n---\n\n## Use Cases and Communication Flows\n\nComplete flow.\n\n## Interface Option Check\n\ninterface_options: not needed - fixture\n\n## OOPDSA Implementation Design\n\nComplete contract.\n";
const seitFixture = "---\ntype: seit\nstatus: complete\n---\n\n## Per-slice Verification and Validation Matrix\n\nComplete matrix.\n\n## Cross-cutting Checks\n\nComplete checks.\n";
const implementationFixture = "# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Import\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** medium.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n**Required lint/static-analysis.** pnpm test\n";
const escapeFixture = (value: string) => value.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function writeDesignPackage(root: string, directory = "docs/plans/import"): Promise<void> {
  await mkdir(join(root, directory), { recursive: true });
  await Promise.all([["plan-spec.md", planFixture], ["design.md", designFixture], ["seit.md", seitFixture], ["review.html", `<html><body>${[planFixture, designFixture, seitFixture].map((value) => `<pre>${escapeFixture(value)}</pre>`).join("")}</body></html>`]].map(([name, content]) => writeFile(join(root, directory, name), content)));
}

async function writePlanningPackage(root: string, directory = "docs/plans/import"): Promise<void> {
  await writeDesignPackage(root, directory);
  await Promise.all([["implementation.md", implementationFixture], ["review.html", `<html><body>${[planFixture, designFixture, seitFixture, implementationFixture].map((value) => `<pre>${escapeFixture(value)}</pre>`).join("")}</body></html>`]].map(([name, content]) => writeFile(join(root, directory, name), content)));
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

  it("marks owner cancellation with uncertain side effects as interrupted only", async () => {
    const input = await request();
    let service!: JourneyService;
    const uncertain: ProcessRunner = {
      executableAvailable: () => true,
      run: async (invocation) => {
        invocation.onActivity?.({ sequence: 1, kind: "tool.started", status: "running", tool: "Write" });
        service.cancel(input.runId);
        return { unknownSideEffect: true };
      },
    };
    service = new JourneyService(uncertain);
    expect(await service.execute(input)).toEqual({ status: "failure", code: "interrupted", tokens: 0 });

    const cleanInput = await request({ runId: "clean-cancel" });
    let cleanService!: JourneyService;
    const clean: ProcessRunner = {
      executableAvailable: () => true,
      run: async () => { cleanService.cancel(cleanInput.runId); return { cancelled: true }; },
    };
    cleanService = new JourneyService(clean);
    expect(await cleanService.execute(cleanInput)).toEqual({ status: "failure", code: "cancelled", tokens: 0 });

    const nativeInput = await request({ runId: "native-interrupted", stage: "review" });
    let nativeService!: JourneyService;
    const native: ProcessRunner = { executableAvailable: () => true, run: async () => { nativeService.cancel(nativeInput.runId); return { unknownSideEffect: true }; } };
    nativeService = new JourneyService(native);
    expect(await nativeService.execute(nativeInput)).toEqual({ status: "failure", code: "interrupted", tokens: 0 });

    const ordinary = new JourneyService(new StubRunner({ unknownSideEffect: true }));
    expect(await ordinary.execute(await request())).toEqual({ status: "failure", code: "adapter_failed", tokens: 0 });
  });

  it("sets bearings locally once, with a bounded reusable map and no process call", async () => {
    const input = await request({ stage: "set-bearings", workGoal: "Add safe account import" });
    await mkdir(join(input.repositoryPath, "node_modules", "hidden"), { recursive: true });
    await Promise.all([
      mkdir(join(input.repositoryPath, ".bearing"), { recursive: true }),
      writeFile(join(input.repositoryPath, "package.json"), '{"name":"fixture"}'),
      writeFile(join(input.repositoryPath, ".env"), "API_KEY=not-for-the-map"),
      writeFile(join(input.repositoryPath, "node_modules", "hidden", "secret.txt"), "not-for-the-map"),
    ]);
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"unused"}'));
    const service = new JourneyService(runner);
    const result = await service.execute(input);
    expect(result).toMatchObject({ status: "action", summary: "Bearings set locally.", tokens: 0 });
    expect(runner.calls).toHaveLength(0);
    if (result.status !== "action") throw new Error("missing local action");
    expect(result.artifacts).toEqual([
      expect.stringMatching(/^docs\/plans\/\d{4}-\d{2}-\d{2}-add-safe-account-import\/prompts\/repository-map\.md$/),
      expect.stringMatching(/^docs\/plans\/\d{4}-\d{2}-\d{2}-add-safe-account-import\/plan-spec\.md$/),
    ]);
    const map = await readFile(join(input.repositoryPath, result.artifacts[0]), "utf8");
    expect(map).toContain("`package.json`");
    expect(map).not.toMatch(/API_KEY|not-for-the-map|node_modules|\.bearing|\.env/);
    expect(service.activityTrail(input.runId).map(({ kind, status }) => [kind, status])).toEqual([
      ["stage.started", "running"],
      ["repository-map.started", "running"],
      ["workspace.ready", "created"],
    ]);
    const resumed = await service.execute({ ...input, planDirectory: result.artifacts[1].replace(/\/plan-spec\.md$/, "") });
    expect(resumed).toMatchObject({ status: "action", summary: "Bearings resumed locally.", artifacts: result.artifacts, tokens: 0 });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a resumed prompts symlink before writing inside or outside the plan", async () => {
    const input = await request({ stage: "set-bearings", workGoal: "Keep resumed maps contained" });
    const planDirectory = "docs/plans/2026-07-20-contained-resume";
    const outside = await realpath(await mkdtemp(join(tmpdir(), "bearing-map-outside-"))); roots.push(outside);
    await mkdir(join(input.repositoryPath, planDirectory), { recursive: true });
    await symlink(outside, join(input.repositoryPath, planDirectory, "prompts"));
    const service = new JourneyService(new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"unused"}')));

    expect(await service.execute({ ...input, planDirectory })).toEqual({ status: "failure", code: "artifact_invalid", tokens: 0 });
    await expect(readFile(join(outside, "repository-map.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(input.repositoryPath, planDirectory, "plan-spec.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a bounded safe server-ordered activity trail and resets it for a new stage", async () => {
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      run: async (invocation) => {
        if (invocation.args.includes("review")) {
          invocation.onActivity?.({ sequence: 999, kind: "turn.completed", status: "completed" });
          return completed("No findings.");
        }
        for (let index = 0; index < 22; index += 1) invocation.onActivity?.({ sequence: 900 + index, kind: "tool.started", status: "running", tool: "Read" });
        invocation.onActivity?.({ sequence: 999, kind: "turn.completed", status: "sk-abcdefgh", tool: "private/source" } as never);
        return completed('BEARING_RESULT {"kind":"question","question":"Continue?"}');
      },
    };
    const service = new JourneyService(runner);
    const input = await request({ priorOwnerQa: [] });
    expect((await service.execute(input)).status).toBe("question");
    const first = service.activityTrail(input.runId);
    expect(first).toHaveLength(20);
    expect(first.map((entry) => entry.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 5));
    expect(first.every((entry) => !Number.isNaN(Date.parse(entry.recordedAt)))).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/sk-abcdefgh|private|source|900|999/);
    expect(first.at(-1)).toMatchObject({ kind: "turn.completed" });

    expect((await service.execute({ ...input, stage: "review" })).status).toBe("action");
    const review = service.activityTrail(input.runId);
    expect(review[0]).toMatchObject({ sequence: 1, kind: "stage.started", status: "running" });
    expect(review.at(-1)).toMatchObject({ kind: "turn.completed" });
    expect(review).toHaveLength(2);
    expect((await service.execute({ ...input, runId: "journey-isolated", stage: "gather-supplies" })).status).toBe("question");
    expect(service.activityTrail(input.runId)).toEqual(review);
    expect(service.activityTrail("journey-isolated")).toHaveLength(20);
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
    expect(runner.calls[0].stdin).toContain('The onboarding selection {"provider":"codex","model":"*","reasoning":"medium"} governs this top-level planning agent and the Explorer/Navigator session.');
    expect(runner.calls[0].stdin).toContain("Implementation.md may record task-appropriate supported model routes and reasoning levels per coding slice");
    expect(runner.calls[0].stdin).toContain("Accepted implementation route labels and supported reasoning levels:");
    expect(runner.calls[0].stdin).toContain("codex agent default [low, medium, high, xhigh, max, ultra]");
    expect(runner.calls[0].stdin).toContain("do not copy a canned duration");
  });

  it("discovers every grilling question in one read-only call and appends the final check", async () => {
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"questions","questions":["Are all source files in this workspace?","Are there reference documents I should use?"],"nextStageEstimate":{"stage":"gather-supplies","minMinutes":4,"maxMinutes":9,"basis":"two owner decisions and one plan file"}}', 21));
    const result = await new JourneyService(runner).execute(await request({ priorOwnerQa: [], gatherMode: "questions" }));
    expect(result).toEqual({ status: "question", question: "Are all source files in this workspace?", questions: ["Are all source files in this workspace?", "Are there reference documents I should use?", "Anything else?"], tokens: 21, nextStageEstimate: { stage: "gather-supplies", minMinutes: 4, maxMinutes: 9, basis: "two owner decisions and one plan file" } });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toContain("read-only");
    expect(runner.calls[0].args).not.toContain("workspace-write");
    expect(runner.calls[0].stdin).toMatch(/return every important unresolved owner question together/i);
    expect(runner.calls[0].stdin).toMatch(/Do not create or modify files during question discovery/i);
    expect(runner.calls[0].stdin).toContain('"stage":"gather-supplies"');
  });

  it("accepts a same-stage estimate on the map-route lens question", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    await mkdir(join(input.repositoryPath, input.planDirectory!), { recursive: true });
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Which design lenses do you approve?","nextStageEstimate":{"stage":"map-route","minMinutes":12,"maxMinutes":20,"basis":"approved lenses cover three design surfaces"}}'));
    expect(await new JourneyService(runner).execute(input)).toMatchObject({ status: "question", nextStageEstimate: { stage: "map-route", minMinutes: 12, maxMinutes: 20 } });
    expect(runner.calls[0].stdin).toContain('"kind":"question","question":"one blocking question","nextStageEstimate":{"stage":"map-route"');
    expect(runner.calls[0].stdin).toContain("including design, SEIT, review generation, implementation drafting, validation, and required agent round trips");
  });

  it("reuses only the matching Codex planning thread", async () => {
    const thread = "123e4567-e89b-12d3-a456-426614174000";
    const question = completed('BEARING_RESULT {"kind":"questions","questions":["Continue?"]}');
    const runner = new QueueRunner([{ ...question, providerSessionId: thread }, question, question, question]);
    const service = new JourneyService(runner);
    const input = await request({ gatherMode: "questions", priorOwnerQa: [] });
    expect((await service.execute(input)).status).toBe("question");
    expect((await service.execute({ ...input, runId: "journey-2" })).status).toBe("question");
    const changedSelection = { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" } as const;
    expect((await service.execute({ ...input, runId: "journey-3", selection: changedSelection, run: resolved(changedSelection) })).status).toBe("question");
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), "bearing-journey-other-"))); roots.push(otherRoot);
    expect((await service.execute({ ...input, runId: "journey-4", repositoryPath: otherRoot })).status).toBe("question");
    expect(runner.calls[0]?.args).not.toContain("resume");
    expect(runner.calls[1]?.args).toEqual(expect.arrayContaining(["exec", "resume", thread]));
    expect(runner.calls[2]?.args).not.toContain("resume");
    expect(runner.calls[3]?.args).not.toContain("resume");
    expect(runner.calls[0]?.args).toContain("read-only");
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
    expect(expeditionRunner.calls[0].stdin).toMatch(/Keep parallel lanes until the entire phase is integrated.*Never force-remove/);

    const preserveRunner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"Proceed?"}'));
    await new JourneyService(preserveRunner).execute(await request({ stage: "execute-explorer", priorOwnerQa: [{ question: "Cleanup merged worktrees", answer: "off" }] }));
    expect(preserveRunner.calls[0].stdin).toContain("Preserve every temporary worktree and branch; the owner disabled automatic cleanup.");

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

  it("covers each model-driven stage with its existing skill or command", async () => {
    const commands = { "gather-supplies": "$grill-with-docs", "map-route": "$design-driven-build", "draft-implementation": "$to-plan", "execute-explorer": "$conductor-orchestrate", "execute-expedition": "$ultimate-loop" } as const;
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

  it("repairs a stale final review with exact current planning sources", async () => {
    const input = await request({ stage: "draft-implementation", planDirectory: "docs/plans/import" });
    await writePlanningPackage(input.repositoryPath);
    const directory = join(input.repositoryPath, input.planDirectory!);
    const currentSeit = seitFixture.replace("Complete matrix.", "Current matrix with <new> evidence.");
    const currentImplementation = implementationFixture.replace("pnpm test", "pnpm typecheck & pnpm test");
    await Promise.all([
      writeFile(join(directory, "seit.md"), currentSeit),
      writeFile(join(directory, "implementation.md"), currentImplementation),
    ]);
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Implementation plan drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"]}'));

    expect(await new JourneyService(runner).execute(input)).toMatchObject({ status: "action", planningReview: { phases: 1, slices: 1 } });
    const review = await readFile(join(directory, "review.html"), "utf8");
    expect(review).toContain('id="bearing-source-artifacts"');
    expect(review).toContain(escapeFixture(currentSeit));
    expect(review).toContain(escapeFixture(currentImplementation));
  });

  it("accepts supported per-slice routing independent of onboarding and rejects invalid routing fields", async () => {
    const input = await request({ stage: "draft-implementation", planDirectory: "docs/plans/import" });
    await writeDesignPackage(input.repositoryPath);
    const writeSlice = async (model: string, reasoning: string, ponytail: string): Promise<void> => {
      const implementation = `# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Import\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** ${model}\n\n**Agent reasoning level.** ${reasoning}\n\n**Ponytail mode.** ${ponytail}\n\n**Review path.** native review\n\n**Required lint/static-analysis.** pnpm test\n`;
      await Promise.all([
        writeFile(join(input.repositoryPath, input.planDirectory!, "implementation.md"), implementation),
        writeFile(join(input.repositoryPath, input.planDirectory!, "review.html"), `<html><body>${[planFixture, designFixture, seitFixture, implementation].map((value) => `<pre>${escapeFixture(value)}</pre>`).join("")}</body></html>`),
      ]);
    };
    const receipt = completed('BEARING_RESULT {"kind":"action","summary":"Implementation plan drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"]}');

    for (const [model, reasoning] of [["Codex agent default", "max"], ["Codex agent default", "ultra"], ["Agy", "thinking"], ["OpenCode", "default"], ["OpenCode", "none"], ["OpenCode", "minimal"], ["Pi", "off"], ["Grok Build", "high"], ["grok-safe (grok-build)", "high"]]) {
      await writeSlice(model, reasoning, "full");
      expect(await new JourneyService(new StubRunner(receipt)).execute(input)).toMatchObject({ status: "action", planningReview: { assignments: [{ model, reasoning }] } });
    }
    await writeSlice("Gork Build", "high", "full");
    expect(await new JourneyService(new StubRunner(receipt)).execute(input)).toMatchObject({ status: "failure", code: "artifact_invalid" });
    await writeSlice("Grok Build", "ultra", "full");
    expect(await new JourneyService(new StubRunner(receipt)).execute(input)).toMatchObject({ status: "failure", code: "artifact_invalid" });
    await writeSlice("Grok Build", "high", "half");
    expect(await new JourneyService(new StubRunner(receipt)).execute(input)).toMatchObject({ status: "failure", code: "artifact_invalid" });
  });

  it("accepts the current selected-model composite and rejects another provider model", async () => {
    const selection = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" };
    const input = await request({ stage: "draft-implementation", planDirectory: "docs/plans/import", selection, run: resolved(selection) });
    await writeDesignPackage(input.repositoryPath);
    const selectedLabel = "Codex `gpt-5.6-sol`";
    const implementation = implementationFixture.replace("Codex agent default", selectedLabel);
    await Promise.all([
      writeFile(join(input.repositoryPath, input.planDirectory!, "implementation.md"), implementation),
      writeFile(join(input.repositoryPath, input.planDirectory!, "review.html"), `<html><body>${[planFixture, designFixture, seitFixture, implementation].map((value) => `<pre>${escapeFixture(value)}</pre>`).join("")}</body></html>`),
    ]);
    const receipt = completed('BEARING_RESULT {"kind":"action","summary":"Implementation plan drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"]}');
    expect(await new JourneyService(new StubRunner(receipt)).execute(input)).toMatchObject({ status: "action", planningReview: { assignments: [{ model: selectedLabel, reasoning: "medium" }] } });
    await writeFile(join(input.repositoryPath, input.planDirectory!, "implementation.md"), implementation.replace(selectedLabel, "Codex `gpt-5.6-terra`"));
    expect(await new JourneyService(new StubRunner(receipt)).execute(input)).toMatchObject({ status: "failure", code: "artifact_invalid" });
  });

  it("accepts only bounded agent next-stage estimates", async () => {
    const input = await request({ gatherMode: "apply", planDirectory: "docs/plans/import" });
    await mkdir(join(input.repositoryPath, input.planDirectory!), { recursive: true });
    await writeFile(join(input.repositoryPath, input.planDirectory!, "plan-spec.md"), planFixture);
    const valid = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Plan saved.","artifacts":["docs/plans/import/plan-spec.md"],"nextStageEstimate":{"stage":"map-route","minMinutes":8,"maxMinutes":14,"basis":"repository map and two design surfaces"}}'));
    expect(await new JourneyService(valid).execute(input)).toMatchObject({ status: "action", nextStageEstimate: { stage: "map-route", minMinutes: 8, maxMinutes: 14 } });
    expect(valid.calls[0].stdin).toContain("Do not estimate from repository inspection size alone");
    const invalid = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Plan saved.","artifacts":["docs/plans/import/plan-spec.md"],"nextStageEstimate":{"stage":"map-route","minMinutes":14,"maxMinutes":8,"basis":"bad range"}}'));
    expect(await new JourneyService(invalid).execute(input)).toEqual({ status: "failure", code: "result_malformed", tokens: 5 });
  });

  it("requests and accepts one generic execution estimate before mode selection", async () => {
    const input = await request({ stage: "draft-implementation", planDirectory: "docs/plans/import" });
    await writePlanningPackage(input.repositoryPath);
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Implementation plan drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"],"nextStageEstimate":{"stage":"execute","minMinutes":10,"maxMinutes":18,"basis":"three bounded implementation slices"}}'));
    expect(await new JourneyService(runner).execute(input)).toMatchObject({ status: "action", nextStageEstimate: { stage: "execute", minMinutes: 10, maxMinutes: 18 } });
    expect(runner.calls[0].stdin).toContain('"nextStageEstimate":{"stage":"execute"');
  });

  it("resumes a validated design baseline and drafts implementation in a separate call", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    await writePlanningPackage(input.repositoryPath);
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Route and implementation drafted.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/implementation.md","docs/plans/import/review.html"]}'));
    expect(await new JourneyService(runner).execute(input)).toMatchObject({ status: "action", planningReview: { phases: 1, slices: 1 } });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].stdin).toContain("Explicitly invoke $to-plan");
    expect(runner.calls[0].stdin).not.toContain("$design-driven-build");
  });

  it("sequences Map the Route across the design stop boundary while keeping one activity stage", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    await mkdir(join(input.repositoryPath, "docs/plans/import"), { recursive: true });
    await writeFile(join(input.repositoryPath, "docs/plans/import/plan-spec.md"), planFixture);
    const calls: ProcessInvocation[] = [];
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      run: async (invocation) => {
        calls.push(invocation);
        if (calls.length === 1) {
          await writeDesignPackage(input.repositoryPath);
          return completed('BEARING_RESULT {"kind":"action","summary":"Design complete.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/review.html"]}', 7);
        }
        await writePlanningPackage(input.repositoryPath);
        return completed('BEARING_RESULT {"kind":"action","summary":"Implementation drafted.","artifacts":["docs/plans/import/implementation.md","docs/plans/import/review.html"]}', 11);
      },
    };
    const service = new JourneyService(runner);

    expect(await service.execute(input)).toMatchObject({ status: "action", summary: "Implementation drafted.", tokens: 18, planningReview: { phases: 1, slices: 1 } });
    expect(calls).toHaveLength(2);
    expect(calls[0].stdin).toMatch(/Explicitly invoke \$design-driven-build[\s\S]*Do not invoke \$to-plan/);
    expect(calls[0].stdin).not.toContain("draft implementation.md and regenerate");
    expect(calls[1].stdin).toContain("Explicitly invoke $to-plan");
    expect(service.activityTrail(input.runId).map((entry) => entry.kind)).toEqual(["stage.started", "design.ready", "implementation-draft.started"]);
  });

  it("repairs a summary-only design review before drafting implementation", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    const directory = join(input.repositoryPath, "docs/plans/import");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plan-spec.md"), planFixture);
    const runner = new QueueRunner([
      completed('BEARING_RESULT {"kind":"action","summary":"Design complete.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/review.html"]}', 7),
      completed('BEARING_RESULT {"kind":"question","question":"Approve the implementation route?"}', 11),
    ]);
    const service = new JourneyService({
      executableAvailable: () => true,
      run: async (invocation) => {
        if (runner.calls.length === 0) {
          await Promise.all([
            writeFile(join(directory, "design.md"), designFixture),
            writeFile(join(directory, "seit.md"), seitFixture),
            writeFile(join(directory, "review.html"), "<!doctype html><html><body><main><h1>Summary only</h1></main></body></html>"),
          ]);
        }
        return runner.run(invocation);
      },
    });

    expect(await service.execute(input)).toEqual({ status: "question", question: "Approve the implementation route?", tokens: 18 });
    const review = await readFile(join(directory, "review.html"), "utf8");
    expect(review).toContain('id="bearing-source-artifacts"');
    expect(review).toContain(escapeFixture(planFixture));
    expect(review).toContain(escapeFixture(designFixture));
    expect(review).toContain(escapeFixture(seitFixture));
  });

  it("creates a complete review when a low-reasoning route omits the HTML artifact", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    const directory = join(input.repositoryPath, "docs/plans/import");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plan-spec.md"), planFixture);
    const runner = new QueueRunner([
      completed('BEARING_RESULT {"kind":"action","summary":"Design complete.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md"]}', 7),
      completed('BEARING_RESULT {"kind":"question","question":"Approve the implementation route?"}', 11),
    ]);
    const service = new JourneyService({
      executableAvailable: () => true,
      run: async (invocation) => {
        if (runner.calls.length === 0) await Promise.all([writeFile(join(directory, "design.md"), designFixture), writeFile(join(directory, "seit.md"), seitFixture)]);
        return runner.run(invocation);
      },
    });

    expect(await service.execute(input)).toEqual({ status: "question", question: "Approve the implementation route?", tokens: 18 });
    const review = await readFile(join(directory, "review.html"), "utf8");
    expect(review).toContain("Bearing planning review");
    expect(review).toContain(escapeFixture(planFixture));
    expect(review).toContain(escapeFixture(designFixture));
    expect(review).toContain(escapeFixture(seitFixture));
  });

  it("does not repair a stale review until the design stage runs again", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    const directory = join(input.repositoryPath, "docs/plans/import");
    await writeDesignPackage(input.repositoryPath);
    await writeFile(join(directory, "plan-spec.md"), "# Revised Plan\n");
    const runner = new QueueRunner([
      completed('BEARING_RESULT {"kind":"action","summary":"Design amended.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/review.html"]}', 7),
      completed('BEARING_RESULT {"kind":"question","question":"Approve the implementation route?"}', 11),
    ]);

    expect(await new JourneyService(runner).execute(input)).toEqual({ status: "question", question: "Approve the implementation route?", tokens: 18 });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].stdin).toContain("Explicitly invoke $design-driven-build");
    expect(await readFile(join(directory, "review.html"), "utf8")).toContain(escapeFixture("# Revised Plan\n"));
  });

  it("rejects a linked review target instead of overwriting it during repair", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    const directory = join(input.repositoryPath, "docs/plans/import");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "plan-spec.md"), planFixture),
      writeFile(join(directory, "design.md"), designFixture),
      writeFile(join(directory, "seit.md"), seitFixture),
      writeFile(join(input.repositoryPath, "unrelated.html"), "do not replace"),
    ]);
    await symlink(join(input.repositoryPath, "unrelated.html"), join(directory, "review.html"));
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Design complete.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/review.html"]}', 7));

    expect(await new JourneyService(runner).execute(input)).toEqual({ status: "failure", code: "artifact_invalid", tokens: 7 });
    expect(await readFile(join(input.repositoryPath, "unrelated.html"), "utf8")).toBe("do not replace");
  });

  it("does not repair review HTML after the owner cancels the design action", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    const directory = join(input.repositoryPath, "docs/plans/import");
    await mkdir(directory, { recursive: true });
    const summary = "<!doctype html><html><body><main><h1>Summary only</h1></main></body></html>";
    await Promise.all([
      writeFile(join(directory, "plan-spec.md"), planFixture),
      writeFile(join(directory, "design.md"), designFixture),
      writeFile(join(directory, "seit.md"), seitFixture),
      writeFile(join(directory, "review.html"), summary),
    ]);
    let service!: JourneyService;
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      run: async () => {
        service.cancel(input.runId);
        return completed('BEARING_RESULT {"kind":"action","summary":"Design complete.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/review.html"]}', 7);
      },
    };
    service = new JourneyService(runner);

    expect(await service.execute(input)).toEqual({ status: "failure", code: "cancelled", tokens: 7 });
    expect(await readFile(join(directory, "review.html"), "utf8")).toBe(summary);
  });

  it("returns a blocking question from the implementation-draft call without rerunning valid design", async () => {
    const input = await request({ stage: "map-route", planDirectory: "docs/plans/import" });
    await writeDesignPackage(input.repositoryPath);
    const runner = new StubRunner(completed('BEARING_RESULT {"kind":"question","question":"How should rollback slices be grouped?"}', 13));

    expect(await new JourneyService(runner).execute(input)).toEqual({ status: "question", question: "How should rollback slices be grouped?", tokens: 13 });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].stdin).toContain("Explicitly invoke $to-plan");
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
    await writePlanningPackage(mapInput.repositoryPath);
    const mapRunner = new StubRunner(completed('BEARING_RESULT {"kind":"action","summary":"Route mapped.","artifacts":["docs/plans/import/design.md","docs/plans/import/seit.md","docs/plans/import/implementation.md","docs/plans/import/review.html"]}'));
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
