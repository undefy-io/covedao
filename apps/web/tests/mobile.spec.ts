import { test, expect } from "@playwright/test";

/** Mobile (390px) read-only smoke coverage (§78/§131). No state mutation. */
test.describe("mobile smoke", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("home renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Covenant-backed/i).first()).toBeVisible();
  });

  test("explore renders", async ({ page }) => {
    await page.goto("/explore");
    await expect(page.getByText("Explore", { exact: true }).first()).toBeVisible();
  });

  test("launch renders review flow", async ({ page }) => {
    await page.goto("/launch");
    await expect(page.getByText("Launch a token").first()).toBeVisible();
  });

  test("market renders (empty/asks)", async ({ page }) => {
    await page.goto("/market");
    await expect(page.getByText("P2P asks").first()).toBeVisible();
  });

  test("wallet renders disconnected state", async ({ page }) => {
    await page.goto("/wallet");
    await expect(page.getByText(/Connect a wallet/i).first()).toBeVisible();
  });

  test("activity renders", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.getByText("Activity", { exact: true }).first()).toBeVisible();
  });
});
