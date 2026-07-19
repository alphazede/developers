import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./egress-guard";

const captureErrors = (page: import("@playwright/test").Page) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test("loads the optional chart after authoritative text and supports keyboard evidence review", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Rhythm fingerprint" });
  const disclosure = page.getByText(/Exact capacity evidence and complete table/);
  const chart = page.getByRole("img", { name: /Optional capacity chart/ });
  await expect(heading).toBeVisible();
  await expect(disclosure).toBeVisible();
  expect(await heading.evaluate((node, other) => Boolean(node.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await chart.elementHandle())).toBe(true);
  await expect(page.getByRole("status", { name: "Optional chart status" })).toContainText("ready");

  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: "Rhythm evidence table" })).toBeVisible();
  const evidence = page.getByText(/Review evidence for/).first();
  await evidence.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("button", { name: "Preview confirm evidence" }).first();
  await confirm.focus();
  await page.keyboard.press("Escape");
  await expect(evidence).toBeFocused();

  await expect(page.getByRole("heading", { name: "Historically demanding meeting pattern" })).toBeVisible();
  await expect(page.getByText("Suggested 15-minute recovery buffer.")).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("previews all evidence controls with keyboard focus and truthful live feedback", async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto("/");
  await page.getByText(/Exact capacity evidence and complete table/).click();
  await page.getByText(/Review evidence for/).first().click();

  for (const [name, action] of [
    ["Preview confirm evidence", "Confirm evidence"],
    ["Preview reject evidence", "Reject evidence"],
    ["Preview correct evidence", "Correct evidence"],
    ["Preview forget evidence", "Forget evidence"],
  ] as const) {
    const control = page.getByRole("button", { name }).first();
    await control.focus();
    await page.keyboard.press("Enter");
    await expect(control).toBeFocused();
    const preview = page.getByRole("status", { name: "Evidence action preview" });
    await expect(preview).toContainText(`${action} requested for`);
    await expect(preview).toContainText("No evidence, source data, or stored records changed.");
    await expect(preview).not.toContainText(/receipt|persisted|deleted|confirmed/i);
  }
  expect(errors).toEqual([]);
});

test.describe("JavaScript-disabled fallback", () => {
  test.use({ javaScriptEnabled: false });
  test("keeps the complete semantic fallback when JavaScript enhancement is disabled", async ({ page }) => {
    const errors = captureErrors(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Rhythm fingerprint" })).toBeVisible();
    const disclosure = page.getByText(/Exact capacity evidence and complete table/);
    await disclosure.click();
    await expect(page.getByRole("table", { name: "Rhythm evidence table" })).toBeVisible();
    await expect(page.getByText(/Loading optional rhythm chart/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("reduced motion and narrow zoom", () => {
  test.use({ viewport: { width: 320, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("preserves content without horizontal overflow at narrow width and 200% zoom", async ({ page }) => {
    const errors = captureErrors(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Rhythm fingerprint" })).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    const overflow = await page.evaluate(() => {
      const pageOverflows = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      return {
        pageOverflows,
        offenders: pageOverflows ? [...document.querySelectorAll<HTMLElement>("*")]
          .filter((node) => node.getBoundingClientRect().right > document.documentElement.scrollWidth + 1 || node.getBoundingClientRect().left < -1)
          .slice(0, 10)
          .map((node) => ({ tag: node.tagName, className: node.className.toString().slice(0, 80) })) : [],
      };
    });
    expect(overflow).toEqual({ pageOverflows: false, offenders: [] });
    const duration = await page.getByTestId("today-shell").evaluate((node) => getComputedStyle(node).transitionDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.01);
    await expect(page.getByText(/Exact capacity evidence and complete table/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
