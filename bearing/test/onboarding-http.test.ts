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
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(body === undefined ? {} : { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...extraHeaders } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
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
    expect(JSON.parse(routes.body).routes).toHaveLength(4);
    expect(counts()).toEqual({ inspections: 4, verifications: 0 });

    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).status).toBe(401);
    const readiness = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, cookie);
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toMatchObject({ status: "detected", detected: true, verified: false });
    expect(counts()).toEqual({ inspections: 5, verifications: 1 });
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
    for (const [name, content] of [["plan-spec.md", "# Plan"], ["design.md", "# Design"], ["seit.md", "# SEIT"], ["implementation.md", "# Implementation"], ["review.html", "<!doctype html><title>Evidence</title>"]] as const) await writeFile(join(root, "plans", "demo", name), content);
    await writeFile(join(root, "plans", "demo", "prompts", "context.md"), "# Context");
    const complete = (content?: string) => ({ exitCode: 0, events: [{ type: "complete", ...(content ? { data: { content } } : {}) }], usage: { tokens: 7 } });
    const action = (summary: string, artifacts: string[]) => `BEARING_RESULT ${JSON.stringify({ kind: "action", summary, artifacts })}`;
    const runner = new SyntheticRunner(undefined, [
      complete(action("Bearings set", ["plans/demo/prompts/context.md", "plans/demo/plan-spec.md"])),
      complete("agent output without a Bearing envelope"),
      complete('BEARING_RESULT {"kind":"question","question":"Which acceptance risk matters most?"}'),
      complete(action("Supplies gathered", ["plans/demo/plan-spec.md"])),
      complete(action("Route mapped", ["plans/demo/design.md", "plans/demo/seit.md", "plans/demo/review.html"])),
      complete(action("Implementation drafted", ["plans/demo/implementation.md"])),
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
    const runId = "browser-test"; const goal = "Ship bounded evidence";
    const journey = (stage: string, extra: Record<string, unknown> = {}) => call(port, "POST", "/api/v1/journey", { runId, stage, workGoal: goal, ...extra }, cookie);
    expect(JSON.parse((await journey("set-bearings")).body)).toMatchObject({ status: "action", summary: "Bearings set" });
    expect(JSON.parse((await journey("gather-supplies")).body)).toMatchObject({ status: "failure", code: "result_missing" });
    expect(JSON.parse((await journey("gather-supplies")).body)).toMatchObject({ status: "question", question: "Which acceptance risk matters most?" });
    expect((await journey("map-route", { answer: "Data loss" })).status).toBe(409);
    expect(JSON.parse((await journey("gather-supplies", { answer: "Data loss" })).body)).toMatchObject({ status: "action" });
    expect(JSON.parse((await journey("map-route")).body)).toMatchObject({ status: "action" });
    expect(JSON.parse((await journey("draft-implementation")).body)).toMatchObject({ status: "action" });
    expect(JSON.parse((await journey("execute-explorer", { executionMode: "explorer", reviewCadence: "phase" })).body)).toMatchObject({ status: "action" });
    const reviewed = JSON.parse((await journey("review")).body);
    expect(reviewed).toMatchObject({ status: "action", summary: "No findings.", artifactLinks: [{ path: "plans/demo/review.html" }] });
    expect(reviewed.artifacts).toEqual(["plans/demo/prompts/context.md", "plans/demo/plan-spec.md", "plans/demo/design.md", "plans/demo/seit.md", "plans/demo/review.html", "plans/demo/implementation.md"]);
    const link = reviewed.artifactLinks[0].url as string;
    expect((await call(port, "GET", link)).status).toBe(401);
    const artifact = await call(port, "GET", link, undefined, cookie);
    expect(artifact.status).toBe(200);
    expect(artifact.body).toContain("<title>Evidence</title>");
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain("Review cadence");
    expect(runner.calls.slice(0, -1).every((invocation) => invocation.args.includes('model_reasoning_effort="low"'))).toBe(true);
    expect(runner.calls.at(-1)?.args).toContain('sandbox_mode="read-only"');
  });

  it("refuses repository changes while a real journey call is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-busy-")); roots.push(root);
    await mkdir(join(root, "plans", "busy"), { recursive: true });
    await writeFile(join(root, "plans", "busy", "plan-spec.md"), "# Plan");
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runner = { executableAvailable: () => true, run: async () => { entered(); await held; return { exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Set","artifacts":["plans/busy/plan-spec.md"]}' } }], usage: { tokens: 1 } }; } };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-busy", stage: "set-bearings", workGoal: "Hold the route" }, cookie);
    await started;
    const blocked = await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.body)).toEqual({ status: "blocked", code: "journey_in_progress" });
    release();
    expect(JSON.parse((await running).body)).toMatchObject({ status: "action" });
  });
});
