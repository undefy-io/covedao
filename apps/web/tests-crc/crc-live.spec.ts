import { expect, test } from "@playwright/test";

test("live CRC catalog, token history, and curve quote work in the browser", async ({ page, request }) => {
  const catalogResponse = await request.get("/api/crc/v1/tokens?limit=1");
  expect(catalogResponse.ok()).toBe(true);
  const catalog = await catalogResponse.json();
  expect(catalog.ok).toBe(true);
  expect(catalog.data.tokens.length).toBeGreaterThan(0);
  const token = catalog.data.tokens[0] as { assetId: string; ticker: string };

  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "Explore tokens" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search tokens" }).fill(token.ticker);
  const card = page.locator(`a[href="/token/${encodeURIComponent(token.assetId)}"]`).first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(page.getByRole("heading", { name: token.ticker, exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed on Bitcoin")).toBeVisible();
  const candlesResponse = await request.get(`/api/crc/v1/tokens/${encodeURIComponent(token.assetId)}/candles?interval=1h`);
  expect(candlesResponse.ok()).toBe(true);
  const candles = await candlesResponse.json();
  expect(candles.ok).toBe(true);
  if (candles.data.tradeCount > 0) await expect(page.getByRole("button", { name: "1H" })).toBeVisible();
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(page.getByText("Total before miner fee:")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("CRC navigation keeps launch, market, activity, and wallet pages available", async ({ page }) => {
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v3/")) legacyRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch a token" })).toBeVisible();
  for (const label of ["Name", "Ticker", "Description", "Website URL", "X URL", "Image URL", "Miner fee (sats)"]) {
    await expect(page.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Market", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Market", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All tokens" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your tokens" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(legacyRequests).toEqual([]);
});

test("removed CRC page routes are unavailable", async ({ request }) => {
  for (const path of ["/crc/launch", "/crc/market", "/crc/activity", "/crc/wallet", "/crc/explore", "/crc/token/signet%3A" + "a".repeat(64)]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});
