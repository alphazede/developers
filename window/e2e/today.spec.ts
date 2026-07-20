import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./egress-guard";

test("renders the deterministic Today surface and supports safe native placement", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 3000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Make room for the work that matters." })).toBeVisible();
  const landingAccessibility = await new AxeBuilder({ page }).analyze();
  expect(landingAccessibility.violations).toEqual([]);
  const dashboardLink = page.getByRole("link", { name: /Open your dashboard/ });
  await expect(dashboardLink).toHaveAttribute("href", "/dashboard");
  await dashboardLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("main", { name: "Pennyworth calendar" })).toBeVisible();
  await expect(page.getByTestId("calendar-workspace")).toBeVisible();
  const fixtureDate = page.getByRole("button", { name: /Select Thursday, July 23/ });
  await expect(fixtureDate).toHaveAttribute("aria-pressed", "true");
  const july22 = page.getByRole("button", { name: /Select Wednesday, July 22/ });
  await july22.hover();
  const dateTooltip = page.getByRole("tooltip");
  await expect(dateTooltip).toBeVisible();
  await expect(dateTooltip).toContainText("Wednesday, July 22");
  await expect(dateTooltip).toContainText("Deep-work block");
  await july22.click();
  await expect(july22).toHaveAttribute("aria-pressed", "true");
  await expect(fixtureDate).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("calendar-rundown").getByRole("heading", { name: "Wednesday, July 22" })).toBeVisible();
  await page.getByTestId("native-scheduling-details").locator(":scope > summary").click();
  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Day plan" })).toBeVisible();
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
  const pickupBox = await pickup.boundingBox();
  const targetBox = await available.boundingBox();
  expect(pickupBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(pickupBox!.x + pickupBox!.width / 2, pickupBox!.y + pickupBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(pickupBox!.x + pickupBox!.width / 2 + 12, pickupBox!.y + pickupBox!.height / 2, { steps: 2 });
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(page.getByRole("status", { name: "Placement updates" })).toContainText("Source task unchanged");
  await expect(page.getByRole("heading", { name: "Local preview" })).toBeVisible();
  await expect(page.getByLabel("GitHub source task, read-only").first()).toContainText("Read-only");

  await pickup.click();
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
    await expect(page.getByRole("heading", { name: "Make room for the work that matters." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/dashboard");
    await expect(page.getByRole("main", { name: "Pennyworth calendar" })).toBeVisible();
    await expect(page.getByTestId("calendar-workspace")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const transitionDuration = await page.getByTestId("today-shell").evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.01);
  });
});

test("follows the system light and dark color scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/dashboard");
  const dark = await page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    day: getComputedStyle(document.querySelector<HTMLElement>(".calendar-rundown")!).backgroundColor,
  }));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.emulateMedia({ colorScheme: "light" });
  const light = await page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    day: getComputedStyle(document.querySelector<HTMLElement>(".calendar-rundown")!).backgroundColor,
  }));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  expect(dark.page).not.toBe(light.page);
  expect(dark.day).not.toBe(light.day);
});
