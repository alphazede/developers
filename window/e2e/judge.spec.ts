import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./egress-guard";

const percentile95 = (samples: number[]) => [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]!;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("@judge completes the fixed synthetic story accessibly without egress or source mutation", async ({ page, request, egressGuard }) => {
  const storyStarted = performance.now(), errors: string[] = [];
  const fixtureRoot = join(process.cwd(), "fixtures/jordan-lee");
  const manifestText = await readFile(join(fixtureRoot, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as { files: Record<string, { sha256: string }> };
  const fixtureBefore = new Map<string, string>();
  for (const [name, evidence] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(fixtureRoot, name), "utf8");
    fixtureBefore.set(name, bytes); expect(sha256(bytes)).toBe(evidence.sha256);
  }

  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  const interactionStarted = performance.now();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Today" })).toBeVisible();
  const initialInteractionMs = performance.now() - interactionStarted;
  expect(initialInteractionMs).toBeLessThan(2_000);

  await expect(page.getByRole("region", { name: "Full day rhythm timeline" })).toBeVisible();
  await expect(page.getByTestId("ruler-time")).toHaveCount(24);
  await page.getByTestId("rhythm-evidence-disclosure").click();
  await expect(page.locator("[data-capacity-status=known]").first()).toBeVisible();
  await expect(page.locator("[data-capacity-status=unknown]").first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Rhythm evidence table" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Historically demanding meeting pattern" })).toBeVisible();
  await expect(page.getByText("Suggested 15-minute recovery buffer.")).toBeVisible();
  await expect(page.locator(".gate-status strong")).toHaveText("Focus Gate is open");
  await expect(page.getByLabel("GitHub source task, read-only").first()).toContainText("Read-only");
  await expect(page.getByLabel("Linear source task, read-only").first()).toContainText("Read-only");

  const baseURL = process.env.JUDGE_BASE_URL ?? "http://127.0.0.1:3100";
  const firstProjection = await (await request.get(`${baseURL}/api/v1/today`)).text();
  const secondProjection = await (await request.get(`${baseURL}/api/v1/today`)).text();
  expect(secondProjection).toBe(firstProjection);
  const projection = JSON.parse(firstProjection) as { backlog: Array<{ id: string; deadlineAt: string | null }>; placementTargets: Record<string, { status: string; candidate?: { startAt: string; endAt: string } }> };
  const taskId = "a1000000-0000-4000-8000-000000000011";
  expect(projection.backlog.find((task) => task.id === taskId)?.deadlineAt).toBe("2026-07-23T21:00:00Z");
  expect(projection.placementTargets[`${taskId}@2026-07-23T20:30:00Z`]).toMatchObject({ status: "candidate", candidate: { startAt: "2026-07-23T20:30:00Z", endAt: "2026-07-23T21:00:00Z" } });

  for (let index = 0; index < 5; index += 1) expect((await request.get(`${baseURL}/api/v1/today`)).status()).toBe(200);
  const apiSamples: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now(), response = await request.get(`${baseURL}/api/v1/today`);
    expect(response.status()).toBe(200); apiSamples.push(performance.now() - started);
  }
  const apiP95 = percentile95(apiSamples);
  expect(apiP95).toBeLessThan(250);
  const recommendationP95 = process.env.JUDGE_BASE_URL ? apiP95 : null;
  if (recommendationP95 !== null) expect(recommendationP95).toBeLessThan(100);

  const pickup = page.getByRole("button", { name: "Pick up Review imported follow-up" });
  await pickup.click();
  const deadlineTarget = page.locator("button", { has: page.locator('time[datetime="2026-07-23T20:30:00Z"]') });
  await deadlineTarget.click();
  const status = page.getByRole("status", { name: "Placement updates" });
  await expect(status).toContainText("Source task unchanged");
  const pointerResult = await status.textContent();
  await deadlineTarget.focus(); await page.keyboard.press("Enter");
  await expect(deadlineTarget).toBeFocused(); await expect(status).toHaveText(pointerResult ?? "");
  const placementP95 = await deadlineTarget.evaluate(async (control) => {
    if (!(control instanceof HTMLButtonElement)) throw new Error("placement control unavailable");
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now(); control.click(); await new Promise<void>((resolve) => queueMicrotask(resolve)); samples.push(performance.now() - started);
    }
    return samples.sort((left, right) => left - right)[94]!;
  });
  expect(placementP95).toBeLessThan(50);
  await expect(page.getByRole("heading", { name: "Local preview" })).toBeVisible();
  await expect(page.getByText(/Recommendation evidence · score/)).toBeVisible();

  const sources = page.getByTestId("sources-privacy");
  await expect(sources.getByText("Normalized payload seam for a separately configured Workspace add-on current-message grant")).toBeVisible();
  await expect(sources.getByText("This route does not validate a Google-issued grant; normal Gmail OAuth and broad Gmail scopes are disabled.")).toBeVisible();
  await expect(sources.getByText("Apple-compatible calendar file path; no Apple credentials requested.")).toBeVisible();
  await expect(sources.getByText(/Fixture only/)).toHaveCount(7);
  await expect(sources.getByText(/Not configured/)).toHaveCount(0);
  await expect(sources.getByText("Deterministic evidence view. Explanations never approve, change, or guarantee a proposal.")).toBeVisible();

  for (const label of ["Preview ICS import", "Preview Microsoft fixture revoke", "Preview data export", "Preview profile deletion"]) {
    const trigger = sources.getByRole("button", { name: label }); await trigger.click();
    const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Acknowledge preview" }).click(); await expect(trigger).toBeFocused();
    await expect(sources.getByText("Preview acknowledged. No data changed; no receipt or effect occurred.")).toBeAttached();
  }

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 640, height: 800 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(Number.parseFloat(await page.getByTestId("today-shell").evaluate((element) => getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.01);

  const heapBytes = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null);
  if (heapBytes !== null) expect(heapBytes).toBeLessThan(256 * 1024 * 1024);
  for (const [name, before] of fixtureBefore) expect(await readFile(join(fixtureRoot, name), "utf8")).toBe(before);
  expect(egressGuard.deniedAttempts).toEqual([]); expect(errors).toEqual([]);
  const storyMs = performance.now() - storyStarted; expect(storyMs).toBeLessThan(180_000);
  console.info("judge-browser-receipt", JSON.stringify({ storyMs: Math.round(storyMs), initialInteractionMs: Number(initialInteractionMs.toFixed(1)), apiP95: Number(apiP95.toFixed(1)), recommendationP95: recommendationP95 === null ? null : Number(recommendationP95.toFixed(1)), placementP95: Number(placementP95.toFixed(1)), heapMiB: heapBytes === null ? null : Number((heapBytes / 1024 / 1024).toFixed(1)), fixtureHash: sha256(manifestText), projectionHash: sha256(firstProjection), deniedEgress: egressGuard.deniedAttempts.length }));
});

test("@judge rejects forbidden browser HTTP and WebSocket attempts", async ({ page, egressGuard }) => {
  const expected = [
    "HTTP GET https://browser-egress.invalid/http-proof",
    "WEBSOCKET wss://browser-egress.invalid/socket-proof",
  ];
  egressGuard.expectDenials(...expected);
  const result = await page.evaluate(async () => {
    const httpRejected = await fetch("https://browser-egress.invalid/http-proof").then(() => false, () => true);
    const websocketRejected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
      const socket = new WebSocket("wss://browser-egress.invalid/socket-proof");
      socket.addEventListener("open", () => finish(false));
      socket.addEventListener("error", () => finish(true));
      socket.addEventListener("close", () => finish(true));
      setTimeout(() => finish(false), 1_000);
    });
    return { httpRejected, websocketRejected };
  });
  expect(result).toEqual({ httpRejected: true, websocketRejected: true });
  expect(egressGuard.deniedAttempts).toEqual(expected);
});
