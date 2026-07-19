import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./egress-guard";

test("shows truthful source and privacy controls with confirm-before-change", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  const section = page.getByTestId("sources-privacy");
  await expect(section.getByRole("heading", { name: "Sources & privacy" })).toBeVisible();
  await expect(section.getByText("Normalized payload seam for a separately configured Workspace add-on current-message grant")).toBeVisible();
  await expect(section.getByText("Normalized title and deadline plus message/thread provenance; the selected fragment and raw body are discarded.")).toBeVisible();
  await expect(section.getByText(/This route does not validate a Google-issued grant; normal Gmail OAuth and broad Gmail scopes are disabled/)).toBeVisible();
  await expect(section.getByText("Apple-compatible calendar file path; no Apple credentials requested.")).toBeVisible();
  await expect(section.getByText(/Fixture only/)).toHaveCount(7);
  await expect(section.getByText(/Not configured/)).toHaveCount(0);

  const trigger = section.getByRole("button", { name: "Preview ICS import" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Preview ICS import" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/no data-changing callback/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Acknowledge preview" }).click();
  await expect(trigger).toBeFocused();
  await expect(section.getByText("Preview acknowledged. No data changed; no receipt or effect occurred.")).toBeAttached();

  const accessibility = await new AxeBuilder({ page }).include("[data-testid=sources-privacy]").analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe("privacy responsive layout", () => {
  test.use({ viewport: { width: 320, height: 800 }, contextOptions: { reducedMotion: "reduce" } });
  test("reflows at 320px and simulated 200% zoom", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("sources-privacy")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
