import { expect, test } from "@playwright/test";
import { assetId, fixture, indexedTip, settle, token } from "./fixtures";

test("token history and indexed state refresh without reloading or resetting trade input", async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  let historyReads = 0, tokenReads = 0, statusReads = 0, quoteReads = 0;
  let hash = indexedTip.blockHash;
  await page.route("**/api/crc/v1/backing/buy/quote", async (route) => { if (route.request().postDataJSON().amountAtoms === "50000000000") quoteReads++; await route.fallback(); });
  await page.route("**/api/crc/v1/status", (route) => {
    statusReads++;
    return route.fulfill({ json: { ok: true, data: { network: "regtest", indexedTip: { ...indexedTip, blockHash: hash } } } });
  });
  await page.route("**/api/crc/v1/tokens/*/activity", (route) => route.fulfill({ json: { ok: true, data: { rows: (historyReads++, hash === indexedTip.blockHash) ? [] : [{
    txid: "ff".repeat(32), blockHeight: "121", operation: "mint", tradeSide: null,
    valid: true, reason: null, amountAtoms: "50000000000",
  }] } } }));
  await page.route("**/api/crc/v1/tokens/*", (route) => route.fulfill({ json: { ok: true, data: {
    token, indexedTip: (tokenReads++, hash === indexedTip.blockHash) ? indexedTip : { ...indexedTip, height: "121" },
  } } }));
  await page.goto(`/token/${encodeURIComponent(assetId)}`);
  await settle(page);
  await expect(page.getByText("No confirmed activity yet.")).toBeVisible();
  await page.getByRole("textbox", { name: "Tokens to buy" }).fill("500");
  await page.getByRole("button", { name: "Review buy" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
  const initialHistoryReads = historyReads, initialTokenReads = tokenReads, initialQuoteReads = quoteReads;
  await page.clock.fastForward(11_000);
  await expect.poll(() => statusReads).toBeGreaterThan(1);
  expect(historyReads).toBe(initialHistoryReads);
  expect(tokenReads).toBe(initialTokenReads);
  // A same-height reorg must refresh the confirmed projections too.
  hash = "99".repeat(32);
  await page.clock.fastForward(6_000);
  await expect(page.getByRole("link", { name: "ffffffffffff…" })).toBeVisible();
  await expect(page.getByText("121", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();
  expect(quoteReads).toBe(initialQuoteReads);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Tokens to buy" })).toHaveValue("500");
  expect(historyReads).toBeGreaterThan(1);
  expect(tokenReads).toBeGreaterThan(1);
});
