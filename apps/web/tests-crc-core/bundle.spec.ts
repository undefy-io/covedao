import { expect, test } from "@playwright/test";
import { assetId, fixture, settle } from "./fixtures";
test("active UI scripts contain only the authoritative CRC implementation and no server modules", async ({ page }) => {
  await fixture(page); const loaded: Promise<void>[] = [], seen = new Set<string>();
  const violations: { url: string; module: string }[] = [];
  const forbidden = /(?:crc20-transactions\/src\/|crc20-curve\/src\/|cove-market\/src\/crc20\/|cove-economics\/src\/|crc20-state\/src\/|crc20-guardian\/src\/|packages\/db\/src\/)/g;
  page.on("response", (response) => {
    const url = response.url();
    if (response.request().resourceType() === "script" && url.includes("/_next/") && !seen.has(url)) {
      seen.add(url);
      loaded.push(response.text().then((source) => {
        for (const module of new Set(source.match(forbidden) ?? [])) violations.push({ url, module });
      }));
    }
  });
  for (const route of ["/", "/explore", `/token/${encodeURIComponent(assetId)}`, "/launch", "/market", "/activity", "/wallet"]) {
    await page.goto(route); await settle(page);
    await Promise.all(loaded);
  }
  await Promise.all(loaded);
  expect(violations).toEqual([]);
});
