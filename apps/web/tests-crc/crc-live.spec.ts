import { expect, test } from "@playwright/test";

test("curve sells appear as Sell in token and global activity", async ({ page, request }) => {
  const catalog = await (await request.get("/api/crc/v1/tokens?limit=1")).json();
  const token = catalog.data.tokens[0] as { assetId: string };
  const deployTxid = token.assetId.split(":")[1];
  const sell = {
    txid: "f".repeat(64), blockHeight: "123", txIndex: 1,
    operation: "transfer", tradeSide: "sell", valid: true,
    deployTxid, amountAtoms: "100000000000", reason: null,
  };
  await page.route("**/api/crc/v1/tokens/*/activity", (route) => route.fulfill({ json: {
    ok: true, data: { rows: [sell] },
  } }));
  await page.route("**/api/crc/v1/activity", (route) => route.fulfill({ json: {
    ok: true, data: { network: token.assetId.split(":")[0], rows: [sell] },
  } }));

  await page.goto(`/token/${encodeURIComponent(token.assetId)}`);
  await expect(page.locator(".ledger-table tbody tr").first()).toContainText("SELL");
  await page.goto("/activity");
  await expect(page.getByText("SELL", { exact: true })).toBeVisible();
});

test("live CRC catalog, token history, and curve quote work in the browser", async ({ page, request }) => {
  const catalogResponse = await request.get("/api/crc/v1/tokens?limit=1");
  expect(catalogResponse.ok()).toBe(true);
  const catalog = await catalogResponse.json();
  expect(catalog.ok).toBe(true);
  expect(catalog.data.tokens.length).toBeGreaterThan(0);
  const token = catalog.data.tokens[0] as { assetId: string; ticker: string; metadata?: { displayName?: string } };

  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "Explore tokens" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search tokens" }).fill(token.ticker);
  const card = page.locator(`a[href="/token/${encodeURIComponent(token.assetId)}"]`).first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(page.getByRole("heading", { name: token.metadata?.displayName || token.ticker, exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed on Bitcoin")).toBeVisible();
  const candlesResponse = await request.get(`/api/crc/v1/tokens/${encodeURIComponent(token.assetId)}/candles?interval=1h`);
  expect(candlesResponse.ok()).toBe(true);
  const candles = await candlesResponse.json();
  expect(candles.ok).toBe(true);
  if (candles.data.tradeCount > 0) await expect(page.getByRole("button", { name: "1H" })).toBeVisible();
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  for (const label of ["25%", "50%", "All"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Buy", exact: true }).click();
  await page.getByRole("button", { name: "Review buy" }).click();
  await expect(page.getByText("Curve price", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Eco/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Standard/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Priority/i })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Miner fee (sats)" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("sell shortcuts use the connected wallet's indexed balance", async ({ page, request }) => {
  const catalog = await (await request.get("/api/crc/v1/tokens?limit=1")).json();
  const token = catalog.data.tokens[0] as { assetId: string; ticker: string };
  await page.addInitScript(() => {
    (window as unknown as { __COVE_TEST_WALLET__: unknown }).__COVE_TEST_WALLET__ = {
      id: "crc-e2e-wallet",
      connect: async () => ({
        adapterId: "crc-e2e-wallet", paymentAddress: "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem",
        paymentScript: "0014" + "1".repeat(40), network: "signet", capabilities: {},
      }),
    };
  });
  await page.route("**/api/crc/v1/wallet/*/balances?*", async (route) => {
    await route.fulfill({ json: { ok: true, data: {
      balances: [{ assetId: token.assetId, ticker: token.ticker, atoms: "950000000000" }], nextCursor: null,
    } } });
  });
  await page.goto(`/token/${encodeURIComponent(token.assetId)}`);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  await page.getByRole("button", { name: "Connect wallet to preview sell" }).click();
  await expect(page.getByText(`You hold 9,500 ${token.ticker}.`)).toBeVisible();
  const amount = page.getByRole("textbox", { name: "Tokens to sell" });
  for (const [button, expected] of [["25%", "2000"], ["50%", "4000"], ["All", "9000"]] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(amount).toHaveValue(expected);
  }
});

test("CRC navigation keeps launch, market, activity, and wallet pages available", async ({ page }) => {
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v3/")) legacyRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch a token" })).toBeVisible();
  for (const label of ["Name", "Ticker", "Description", "Website URL", "X URL", "Image URL"]) {
    await expect(page.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Miner fee (sats)" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Fee Review Token");
  await page.getByRole("textbox", { name: "Ticker", exact: true }).fill("FEE");
  await page.getByRole("button", { name: "Review launch" }).click();
  await expect(page.getByRole("button", { name: /Standard/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Priority/i })).toBeVisible();
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
