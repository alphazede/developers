import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("renders the deterministic Today surface and supports safe native placement", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("main", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Personal rhythm" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Full day rhythm timeline" })).toHaveAttribute("data-day-start", "2026-07-23T05:00:00Z");
  await expect(page.getByTestId("ruler-time")).toHaveCount(24);
  await expect(page.locator(".gate-status strong")).toHaveText("Focus Gate is open");
  await expect(page.getByLabel("GitHub source task, read-only").first()).toContainText("Read-only");

  const response = await page.request.get("/api/v1/today");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers()["content-type"]).toBe("application/vnd.capacity-scheduling.today.v1+json");
  const projection = await response.json() as { revision: number };
  await expect(page.getByTestId("today-page")).toHaveAttribute("data-revision", String(projection.revision));

  const pickup = page.getByRole("button", { name: "Pick up Review imported follow-up" });
  await pickup.click();
  await expect(page.getByRole("status", { name: "Placement updates" })).toContainText("Picked up Review imported follow-up");

  const available = page.getByRole("button", { name: /Place at 15:30.*Available/ });
  await available.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Placement updates" })).toContainText("Source task unchanged");
  await expect(available).toBeFocused();
  await expect(page.getByRole("heading", { name: "Local preview" })).toBeVisible();

  const rejected = page.getByRole("button", { name: /Conflicts with committed or protected time/ });
  await expect(rejected).toHaveAttribute("data-target-rejection", "hard-conflict");
  await rejected.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Placement updates" })).toContainText("Could not place Review imported follow-up");
  await expect(rejected).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe("responsive and motion preferences", () => {
  test.use({ viewport: { width: 320, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("reflows at 320px and simulated 200% zoom without page overflow", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("main", { name: "Today" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const transitionDuration = await page.getByTestId("today-shell").evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.01);
  });
});
