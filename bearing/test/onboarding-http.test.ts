import { createServer, request, type Server } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionService, SESSION_COOKIE_NAME, createRequestHandler } from "../src/server/local-session.js";
import { SyntheticRunner } from "../src/adapters/adapters.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function launch(available = true) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const port = String(address.port);
  const session = new LocalSessionService(`127.0.0.1:${port}`);
  let inspections = 0;
  let verifications = 0;
  server.on("request", createRequestHandler(session, undefined, {
    routeInspection: { executableAvailable: () => { inspections += 1; return available; } },
    verification: { verify: async () => { verifications += 1; return false; } },
  }));
  return { port, session, counts: () => ({ inspections, verifications }) };
}

function call(port: string, method: string, path: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(body === undefined ? {} : { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...extraHeaders } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

async function launchChoice(repositoryChoice: NonNullable<Parameters<typeof createRequestHandler>[2]>["repositoryChoice"]) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const port = String(address.port);
  const session = new LocalSessionService(`127.0.0.1:${port}`);
  server.on("request", createRequestHandler(session, undefined, { repositoryChoice }));
  return { port, session };
}

async function authenticate(port: string, session: LocalSessionService): Promise<string> {
  const exchanged = session.exchange(session.capability);
  if (!exchanged.ok) throw new Error("exchange failed");
  return `${SESSION_COOKIE_NAME}=${exchanged.cookieValue}`;
}

async function postOwnerCommand(port: string, cookie: string, runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const state = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body) as { revision: number };
  const id = `test-${state.revision}-${type}`;
  const response = await call(port, "POST", `/api/v1/runs/${runId}/commands`, { schemaVersion: 1, commandId: id, runId, expectedRevision: state.revision, session: { sessionId: "test", actor: "owner" }, correlationId: id, type, payload }, cookie);
  expect(response.status).toBe(200);
}

async function recordPlanningApproval(port: string, cookie: string, runId: string): Promise<void> {
  const decisionId = "planning-package-review";
  await postOwnerCommand(port, cookie, runId, "requireDecision", { decisionId, question: "Approve the complete planning package before implementation?", consequential: true });
  await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId, answer: "Approved for execution-mode selection" });
}

describe("repository-first onboarding HTTP", () => {
  it("serves authenticated repository options and rejects cross-origin reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-options-")); roots.push(root);
    const choice = { options: async () => ({ platform: "linux" as const, linuxDistro: "Test Linux", current: { path: root, source: "cwd" as const }, browse: { available: false } }), resolve: async () => ({ result: "selected" as const, candidate: root, source: "cwd" as const }) };
    const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
    expect((await call(port, "GET", "/api/v1/repository-options")).status).toBe(401);
    expect((await call(port, "GET", "/api/v1/repository-options", undefined, cookie, { origin: "https://evil.example" })).status).toBe(403);
    const response = await call(port, "GET", "/api/v1/repository-options", undefined, cookie);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ platform: "linux", linuxDistro: "Test Linux", current: { path: root, source: "cwd" }, browse: { available: false } });
  });

  it("accepts repository reselection without restarting onboarding", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-current-")); roots.push(root); let resolutions = 0;
    const choice = { options: async () => ({ platform: "linux" as const, current: { path: root, source: "cwd" as const }, browse: { available: false } }), resolve: async () => { resolutions += 1; return { result: "selected" as const, candidate: root, source: "cwd" as const }; } };
    const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/repository", { choice: "current" }, cookie)).status).toBe(200);
    const repeated = await call(port, "POST", "/api/v1/repository", { choice: "browse" }, cookie);
    expect(repeated.status).toBe(200);
    expect(JSON.parse(repeated.body).status).toBe("resumed");
    expect(resolutions).toBe(2);
  });

  it("returns stable recoverable picker outcomes without repository mutation", async () => {
    for (const result of ["cancelled", "unavailable", "timeout", "invalid"] as const) {
      const root = await mkdtemp(join(tmpdir(), `bearing-${result}-`)); roots.push(root);
      const choice = { options: async () => ({ platform: "linux" as const, current: { path: root, source: "cwd" as const }, browse: { available: true, picker: "zenity" as const } }), resolve: async () => ({ result, picker: "zenity" as const }) };
      const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
      const response = await call(port, "POST", "/api/v1/repository", { choice: "browse" }, cookie);
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ status: "blocked", code: `repository_picker_${result}` });
      await expect(access(join(root, ".bearing"))).rejects.toBeDefined();
    }
  });

  it("validates picker output through RepositoryBootstrap and rejects malformed choice bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-hostile-picker-")); roots.push(root); const file = join(root, "not-a-directory"); await writeFile(file, "x");
    const choice = { options: async () => ({ platform: "linux" as const, current: { path: root, source: "cwd" as const }, browse: { available: true, picker: "zenity" as const } }), resolve: async () => ({ result: "selected" as const, candidate: file, source: "picker" as const, picker: "zenity" as const }) };
    const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/repository", { choice: "browse" }, cookie)).status).toBe(400);
    await expect(access(join(root, ".bearing"))).rejects.toBeDefined();

    const next = await launchChoice(choice); const nextCookie = await authenticate(next.port, next.session);
    for (const body of [{ choice: "recent" }, { choice: "current", path: root }, { choice: "current", extra: true }]) {
      expect((await call(next.port, "POST", "/api/v1/repository", body, nextCookie)).status).toBe(422);
    }
    expect((await call(next.port, "POST", "/api/v1/repository", { choice: "current" })).status).toBe(401);
    expect((await call(next.port, "POST", "/api/v1/repository", { choice: "current" }, nextCookie, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("requires repository and authentication before passive inspection/readiness", async () => {
    const { port, session, counts } = await launch();
    const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).status).toBe(401);
    expect((await call(port, "GET", "/api/v1/routes", undefined, cookie)).status).toBe(409);
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, cookie)).status).toBe(409);
    expect(counts()).toEqual({ inspections: 0, verifications: 0 });

    const root = await mkdtemp(join(tmpdir(), "bearing-onboarding-"));
    roots.push(root);
    expect((await call(port, "POST", "/api/v1/repository", { path: root }, cookie)).status).toBe(200);
    expect((await call(port, "GET", "/api/v1/routes")).status).toBe(401);
    const routes = await call(port, "GET", "/api/v1/routes", undefined, cookie);
    expect(routes.status).toBe(200);
    expect(JSON.parse(routes.body).routes).toHaveLength(6);
    expect(counts()).toEqual({ inspections: 6, verifications: 0 });

    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).status).toBe(401);
    const readiness = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, cookie);
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toMatchObject({ status: "detected", detected: true, verified: false });
    expect(counts()).toEqual({ inspections: 7, verifications: 1 });
    expect(readiness.body.length).toBeLessThan(16_384);
  });

  it("rejects malformed selection and returns the stable unavailable repair", async () => {
    const { port, session } = await launch(false);
    const cookie = await authenticate(port, session);
    const root = await mkdtemp(join(tmpdir(), "bearing-onboarding-"));
    roots.push(root);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const missing = await call(port, "POST", "/api/v1/readiness", {}, cookie);
    expect(missing.status).toBe(409);
    expect(JSON.parse(missing.body)).toMatchObject({ code: "selection_unavailable", repair: "choose_detected_route" });
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "x", reasoning: "maximum" }, cookie)).status).toBe(400);
    const unavailable = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }, cookie);
    expect(unavailable.status).toBe(409);
    expect(JSON.parse(unavailable.body)).toEqual({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" });
  });

  it("uses the injected adapter path and canonical selected repository for verification", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port);
    const session = new LocalSessionService(`127.0.0.1:${port}`);
    const runner = new SyntheticRunner();
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner }));
    const cookie = await authenticate(port, session);
    const root = await mkdtemp(join(tmpdir(), "bearing-onboarding-")); roots.push(root);
    const chosen = await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const canonical = JSON.parse(chosen.body).repositoryPath as string;
    const readiness = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    expect(JSON.parse(readiness.body)).toMatchObject({ status: "ready", verified: true });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ executable: "codex", cwd: canonical });
    expect(runner.calls[0].args).not.toContain("-m");
    expect(runner.calls[0].args).toContain('model_reasoning_effort="medium"');
    expect(runner.calls[0].args).not.toContain(runner.calls[0].stdin);
    expect(runner.calls[0].stdin).toMatch(/readiness/i);
  });

  it("persists the verified route and drives the real journey through contained HTML evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-journey-")); roots.push(root);
    await mkdir(join(root, "plans", "demo", "prompts"), { recursive: true });
    const planning = { "plan-spec.md": "# Plan", "design.md": "# Design", "seit.md": "# SEIT", "implementation.md": "# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Deliver\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** low\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n**Required lint/static-analysis.** pnpm test" } as const;
    const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    for (const [name, content] of Object.entries(planning)) await writeFile(join(root, "plans", "demo", name), content);
    await writeFile(join(root, "plans", "demo", "review.html"), `<!doctype html><title>Evidence</title>${Object.entries(planning).map(([name, content]) => `<h2>${name}</h2><pre>${escaped(content)}</pre>`).join("")}`);
    await writeFile(join(root, "plans", "demo", "prompts", "context.md"), "# Context");
    const complete = (content?: string) => ({ exitCode: 0, events: [{ type: "complete", ...(content ? { data: { content } } : {}) }], usage: { tokens: 7 } });
    const action = (summary: string, artifacts: string[]) => `BEARING_RESULT ${JSON.stringify({ kind: "action", summary, artifacts })}`;
    const runner = new SyntheticRunner(undefined, [
      complete(action("Bearings set", ["plans/demo/prompts/context.md", "plans/demo/plan-spec.md"])),
      complete("agent output without a Bearing envelope"),
      complete('BEARING_RESULT {"kind":"questions","questions":["Which acceptance risk matters most?"]}'),
      complete(action("Supplies gathered", ["plans/demo/plan-spec.md"])),
      complete(action("Route mapped", ["plans/demo/design.md", "plans/demo/seit.md", "plans/demo/review.html"])),
      complete(action("Implementation drafted", ["plans/demo/implementation.md", "plans/demo/review.html"])),
      complete(action("Review changes gathered", ["plans/demo/plan-spec.md"])),
      complete(action("Route remapped", ["plans/demo/design.md", "plans/demo/seit.md", "plans/demo/review.html"])),
      complete(action("Implementation redrafted", ["plans/demo/implementation.md", "plans/demo/review.html"])),
      complete('BEARING_RESULT {"kind":"question","question":"May I replace the generated client?"}'),
      complete(action("Explorer completed bounded work", ["plans/demo/implementation.md"])),
      complete("No findings."),
    ]);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port); const session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true }, startupOverrides: { reasoning: "low" } }));
    const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/repository", { path: root }, cookie)).status).toBe(200);
    expect(JSON.parse((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie)).body)).toMatchObject({ status: "ready", verified: true });
    const runId = "browser-test"; const goal = "Ship bounded evidence\nwithout losing owner control";
    const journey = (stage: string, extra: Record<string, unknown> = {}) => call(port, "POST", "/api/v1/journey", { runId, stage, workGoal: goal, ...extra }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    expect(JSON.parse((await journey("set-bearings")).body)).toMatchObject({ status: "action", summary: "Bearings set" });
    expect(JSON.parse((await journey("gather-supplies")).body)).toMatchObject({ status: "failure", code: "result_missing" });
    expect(JSON.parse((await journey("gather-supplies")).body)).toMatchObject({ status: "question", question: "Which acceptance risk matters most?" });
    expect((await journey("map-route", { answer: "Data loss" })).status).toBe(409);
    const planningQuestion = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    expect(planningQuestion).toMatchObject({ question: "Which acceptance risk matters most?" });
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: planningQuestion.decisionId, answer: "Data loss" });
    expect(JSON.parse((await journey("gather-supplies", { answer: "Data loss" })).body)).toMatchObject({ status: "question", question: "Anything else?" });
    const finalPlanningQuestion = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: finalPlanningQuestion.decisionId, answer: "No" });
    expect(JSON.parse((await journey("gather-supplies", { answer: "No" })).body)).toMatchObject({ status: "action" });
    expect(JSON.parse((await journey("map-route")).body)).toMatchObject({ status: "action" });
    expect(JSON.parse((await journey("draft-implementation")).body)).toMatchObject({ status: "action", planningReview: { phases: 1, slices: 1, assignments: [{ slice: "Slice 1.1 — Deliver", role: "Backend Engineer", model: "Codex agent default", reasoning: "low" }] } });
    expect(JSON.parse((await journey("gather-supplies", { reviewChange: "Add a rollback acceptance check" })).body)).toMatchObject({ status: "action", summary: "Review changes gathered" });
    expect(JSON.parse((await journey("map-route")).body)).toMatchObject({ status: "action", summary: "Route remapped" });
    expect(JSON.parse((await journey("draft-implementation")).body)).toMatchObject({ status: "action", summary: "Implementation redrafted" });
    expect((await journey("execute-explorer", { executionMode: "explorer", reviewCadence: "phase" })).status).toBe(409);
    await recordPlanningApproval(port, cookie, runId);
    expect(JSON.parse((await journey("execute-explorer", { executionMode: "explorer", reviewCadence: "phase" })).body)).toMatchObject({ status: "question", question: "May I replace the generated client?" });
    const executionQuestion = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    expect(executionQuestion).toMatchObject({ question: "May I replace the generated client?" });
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: executionQuestion.decisionId, answer: "Yes, keep the public API stable" });
    expect(JSON.parse((await journey("execute-explorer", { answer: "Yes, keep the public API stable" })).body)).toMatchObject({ status: "action" });
    const reviewed = JSON.parse((await journey("review")).body);
    expect(reviewed).toMatchObject({ status: "action", summary: "No findings." });
    expect(reviewed.artifacts).toEqual(["plans/demo/prompts/context.md", "plans/demo/plan-spec.md", "plans/demo/design.md", "plans/demo/seit.md", "plans/demo/review.html", "plans/demo/implementation.md"]);
    expect(reviewed.artifactLinks.map((link: { path: string }) => link.path)).toEqual(["plans/demo/prompts/context.md", "plans/demo/plan-spec.md", "plans/demo/design.md", "plans/demo/seit.md", "plans/demo/review.html", "plans/demo/implementation.md"]);
    const htmlLink = reviewed.artifactLinks.find((link: { path: string }) => link.path.endsWith("review.html")).url as string;
    expect((await call(port, "GET", htmlLink)).status).toBe(401);
    const artifact = await call(port, "GET", htmlLink, undefined, cookie);
    expect(artifact.status).toBe(200);
    expect(artifact.body).toContain("<title>Evidence</title>");
    const markdownLink = reviewed.artifactLinks.find((link: { path: string }) => link.path.endsWith("implementation.md")).url as string;
    const markdown = await call(port, "GET", markdownLink, undefined, cookie);
    expect(markdown.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(markdown.body).toContain("Agent reasoning level");
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain("Review cadence");
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain("Add a rollback acceptance check");
    expect(runner.calls.slice(0, -1).every((invocation) => invocation.args.includes('model_reasoning_effort="low"'))).toBe(true);
    expect(runner.calls.at(-1)?.args).toContain('sandbox_mode="read-only"');
  });

  it("collects a batch of grilling answers without restarting the agent between questions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-batched-grill-")); roots.push(root);
    await mkdir(join(root, "plans", "batch"), { recursive: true });
    await writeFile(join(root, "plans", "batch", "plan-spec.md"), "# Plan\n");
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const questions = Array.from({ length: 16 }, (_, index) => `${index}: Planning question ${index + 1}`.padEnd(4095, "q") + "?");
    const runner = new SyntheticRunner(undefined, [
      result('BEARING_RESULT {"kind":"question","question":"Which repository boundary applies?"}'),
      result('BEARING_RESULT {"kind":"action","summary":"Bearings set","artifacts":["plans/batch/plan-spec.md"]}'),
      result(`BEARING_RESULT ${JSON.stringify({ kind: "questions", questions })}`),
      result('BEARING_RESULT {"kind":"action","summary":"Route map written","artifacts":["plans/batch/plan-spec.md"]}'),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const runId = "browser-batch", goal = "Plan without per-answer lag";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    const journey = (extra: Record<string, unknown> = {}) => call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal, ...extra }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "Which repository boundary applies?" });
    const setPending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: setPending.decisionId, answer: "Only this repository" });
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal, answer: "Only this repository" }, cookie)).body)).toMatchObject({ status: "action" });

    let response = JSON.parse((await journey()).body);
    expect(response).toMatchObject({ status: "question", question: questions[0] });
    expect(response.questions).toEqual([...questions, "Anything else?"]);
    expect(runner.calls).toHaveLength(3);
    const answers = [...questions.map((_, index) => `${index}:`.padEnd(4096, "x")), "No"];
    for (const answer of answers) {
      const pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
      await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer });
      response = JSON.parse((await journey({ answer })).body);
      if (answer !== "No") expect(runner.calls).toHaveLength(3);
    }
    expect(response).toMatchObject({ status: "action", summary: "Route map written" });
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls[3].stdin).toContain('"question":"Anything else?","answer":"No"');
    expect(runner.calls[3].stdin).toContain(`"question":"${questions[0]}","answer":"${answers[0]}"`);
    expect(runner.calls[3].stdin).toContain('"question":"Which repository boundary applies?","answer":"Only this repository"');
    expect(runner.calls[3].stdin).toMatch(/All grilling questions are answered/i);
  });

  it("refuses repository changes while a real journey call is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-busy-")); roots.push(root);
    await mkdir(join(root, "plans", "busy"), { recursive: true });
    await writeFile(join(root, "plans", "busy", "plan-spec.md"), "# Plan");
    let release!: (result: { cancelled: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<{ cancelled: true }>((resolve) => { release = resolve; });
    const runner = { executableAvailable: () => true, run: async () => { entered(); return await held; }, cancel: () => release({ cancelled: true }) };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-busy", "createWorkRequest", { title: "Hold the route", goal: "Hold the route" });
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-busy", stage: "set-bearings", workGoal: "Hold the route" }, cookie);
    await started;
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId: "browser-busy", goal: "Hold the route", status: "running", busy: true })]);
    const blocked = await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.body)).toEqual({ status: "blocked", code: "journey_in_progress" });
    expect((await call(port, "POST", "/api/v1/journey/control", { runId: "browser-busy", action: "stop" }, cookie)).status).toBe(200);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "failure", code: "cancelled" });
  });

  it("preserves an ambiguous stop result instead of advertising a safe retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-stop-ambiguous-")); roots.push(root);
    let release!: (result: { unknownSideEffect: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const runner = { executableAvailable: () => true, run: async () => { entered(); return await new Promise<{ unknownSideEffect: true }>((resolve) => { release = resolve; }); }, cancel: () => release({ unknownSideEffect: true }) };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-stop-ambiguous", "createWorkRequest", { title: "Do not hide partial writes", goal: "Do not hide partial writes" });
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-stop-ambiguous", stage: "set-bearings", workGoal: "Do not hide partial writes" }, cookie);
    await started;
    expect((await call(port, "POST", "/api/v1/journey/control", { runId: "browser-stop-ambiguous", action: "stop" }, cookie)).status).toBe(200);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "failure", code: "adapter_failed" });
  });

  it("restores a durable journey checkpoint after repository reselection", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-resume-")); roots.push(root);
    await mkdir(join(root, "plans", "resume"), { recursive: true });
    await writeFile(join(root, "plans", "resume", "plan-spec.md"), "# Resume plan");
    const complete = (summary: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content: `BEARING_RESULT ${JSON.stringify({ kind: "action", summary, artifacts: ["plans/resume/plan-spec.md"] })}` } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [complete("Bearings saved"), { exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"questions","questions":[]}' } }], usage: { tokens: 1 } }]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-resume", goal = "Resume this route";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).body)).toMatchObject({ status: "action", summary: "Bearings saved" });
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId, stage: "set-bearings", status: "waiting", busy: false, artifacts: ["plans/resume/plan-spec.md"], lastResult: expect.objectContaining({ status: "action", summary: "Bearings saved" }) })]);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "Anything else?" });
  });

  it("reconciles an answered checkpoint question before resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-answer-resume-")); roots.push(root);
    await mkdir(join(root, "plans", "answer"), { recursive: true });
    await writeFile(join(root, "plans", "answer", "plan-spec.md"), "# Answered plan\n");
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [
      result('BEARING_RESULT {"kind":"action","summary":"Bearings saved","artifacts":["plans/answer/plan-spec.md"]}'),
      result('BEARING_RESULT {"kind":"questions","questions":["Which boundary matters?","Which fallback is acceptable?"]}'),
      result('BEARING_RESULT {"kind":"questions","questions":[]}'),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-answer-resume", goal = "Resume an answered question";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "Which boundary matters?" });
    const pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer: "The public API" });
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId, status: "failed", lastResult: { status: "failure", code: "interrupted", tokens: 0 } })]);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "Anything else?" });
    expect(runner.calls.at(-1)?.stdin).toContain("The public API");
    expect(runner.calls.at(-1)?.stdin).toMatch(/return every important unresolved owner question together/i);
  });

  it("restores an unanswered question batch without losing its in-memory queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-unanswered-resume-")); roots.push(root);
    await mkdir(join(root, "plans", "unanswered"), { recursive: true });
    await writeFile(join(root, "plans", "unanswered", "plan-spec.md"), "# Unanswered plan\n");
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [
      result('BEARING_RESULT {"kind":"action","summary":"Bearings saved","artifacts":["plans/unanswered/plan-spec.md"]}'),
      result('BEARING_RESULT {"kind":"questions","questions":["First decision?","Second decision?"]}'),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-unanswered-resume", goal = "Resume an unanswered batch";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "First decision?" });
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId, status: "waiting", lastResult: expect.objectContaining({ status: "question", question: "First decision?" }) })]);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    const pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer: "First answer" });
    const resumed = await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal, answer: "First answer" }, cookie);
    expect(resumed.status, resumed.body).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "question", question: "Second decision?" });
    expect(runner.calls).toHaveLength(2);
  });

  it("rejects a restored journey when the newly selected model route differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-route-lock-")); roots.push(root);
    const runner = new SyntheticRunner(undefined, [{ exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Bearings saved","artifacts":[]}' } }], usage: { tokens: 1 } }]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-route-lock", goal = "Keep the approved route";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    expect((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).status).toBe(200);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "GET", "/api/v1/history", undefined, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "high" }, cookie);
    expect((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).status).toBe(409);
  });

  it("restores an explicitly requested checkpoint older than the bounded history list", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-old-run-")); roots.push(root);
    await mkdir(join(root, "plans", "old"), { recursive: true });
    await writeFile(join(root, "plans", "old", "plan-spec.md"), "# Old run\n");
    const results = Array.from({ length: 9 }, (_, index) => ({ exitCode: 0, events: [{ type: "complete", data: { content: `BEARING_RESULT {"kind":"action","summary":"Run ${index}","artifacts":["plans/old/plan-spec.md"]}` } }], usage: { tokens: 1 } }));
    const runner = new SyntheticRunner(undefined, results);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    for (let index = 0; index < 9; index += 1) {
      const runId = `browser-old-${index}`, goal = `Remember run ${index}`;
      await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
      expect((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).status).toBe(200);
    }
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    const status = JSON.parse((await call(port, "GET", "/api/v1/journey/browser-old-0/status", undefined, cookie)).body);
    expect(status.run).toMatchObject({ runId: "browser-old-0", goal: "Remember run 0", stage: "set-bearings", status: "waiting" });
  });

  it("restarts a safely cancelled phase with owner steering", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-steer-")); roots.push(root);
    await mkdir(join(root, "plans", "steer"), { recursive: true });
    await writeFile(join(root, "plans", "steer", "plan-spec.md"), "# Plan");
    let release!: (result: { cancelled: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: { stdin: string }[] = [];
    const runner = {
      executableAvailable: () => true,
      run: async (invocation: { stdin: string }) => {
        calls.push(invocation);
        if (calls.length === 1) { entered(); return await new Promise<{ cancelled: true }>((resolve) => { release = resolve; }); }
        return { exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Steered","artifacts":["plans/steer/plan-spec.md"]}' } }], usage: { tokens: 1 } };
      },
      cancel: () => release({ cancelled: true }),
    };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-steer", "createWorkRequest", { title: "Steer safely", goal: "Steer safely" });
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-steer", stage: "set-bearings", workGoal: "Steer safely" }, cookie);
    await started;
    expect((await call(port, "POST", "/api/v1/journey/control", { runId: "browser-steer", action: "steer", instruction: "Use the narrower API boundary" }, cookie)).status).toBe(200);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "action", summary: "Steered" });
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin).toContain("Owner steering during set-bearings");
    expect(calls[1].stdin).toContain("Use the narrower API boundary");
  });

  it("does not replay a steered phase after ambiguous side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-steer-ambiguous-")); roots.push(root);
    let release!: (result: { unknownSideEffect: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: unknown[] = [];
    const runner = {
      executableAvailable: () => true,
      run: async (invocation: unknown) => { calls.push(invocation); entered(); return await new Promise<{ unknownSideEffect: true }>((resolve) => { release = resolve; }); },
      cancel: () => release({ unknownSideEffect: true }),
    };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-steer-ambiguous", "createWorkRequest", { title: "Do not duplicate writes", goal: "Do not duplicate writes" });
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-steer-ambiguous", stage: "set-bearings", workGoal: "Do not duplicate writes" }, cookie);
    await started;
    await call(port, "POST", "/api/v1/journey/control", { runId: "browser-steer-ambiguous", action: "steer", instruction: "Change direction" }, cookie);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "failure", code: "adapter_failed" });
    expect(calls).toHaveLength(1);
  });
});
