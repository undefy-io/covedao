import { expect, test } from "@playwright/test";

test("live CRC catalog, token history, and curve quote work in the browser", async ({ page, request }) => {
  const catalogResponse = await request.get("/api/crc/v1/tokens?limit=1");
  expect(catalogResponse.ok()).toBe(true);
  const catalog = await catalogResponse.json();
  expect(catalog.ok).toBe(true);
  expect(catalog.data.tokens.length).toBeGreaterThan(0);
  const token = catalog.data.tokens[0] as { assetId: string; ticker: string };

  await page.goto("/crc/explore");
  await expect(page.getByRole("heading", { name: "Explore tokens" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search tokens" }).fill(token.ticker);
  const card = page.locator(`a[href="/crc/token/${encodeURIComponent(token.assetId)}"]`).first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(page.getByRole("heading", { name: token.ticker, exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed on Bitcoin")).toBeVisible();
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(page.getByText("Total before miner fee:")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("CRC navigation keeps launch, market, activity, and wallet pages available", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch a token" })).toBeVisible();
  await page.getByRole("link", { name: "Market", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Market", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your tokens" })).toBeVisible();
});
