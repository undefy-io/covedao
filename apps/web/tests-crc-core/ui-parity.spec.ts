import { expect, test, type Page } from "@playwright/test";
import { assetId, fixture, settle } from "./fixtures";

for (const path of ["/", "/explore", "/token/" + encodeURIComponent(assetId), "/launch", "/market", "/activity", "/wallet"]) {
  test(`unchanged UI matches 5dded6a pixels and controls at ${path}`, async ({ page, context }, info) => {
    const baseline = await context.newPage();
    await fixture(page); await fixture(baseline);
    await Promise.all([page.goto(path), baseline.goto((process.env.CRC_CORE_BASELINE_URL ?? "http://127.0.0.1:3119") + path)]);
    await Promise.all([settle(page), settle(baseline)]);
    if (path === "/" || path === "/explore") await Promise.all([
      expect(page.locator(`main a[href="/token/${encodeURIComponent(assetId)}"]`).first()).toBeVisible({ timeout: 30_000 }),
      expect(baseline.locator(`main a[href="/token/${encodeURIComponent(assetId)}"]`).first()).toBeVisible({ timeout: 30_000 }),
    ]);
    if (path.startsWith("/token/")) await Promise.all([
      expect(page.getByRole("heading", { name: "Test Token", exact: true })).toBeVisible(),
      expect(baseline.getByRole("heading", { name: "Test Token", exact: true })).toBeVisible(),
    ]);
    if (path === "/market") await Promise.all([
      expect(page.getByRole("button", { name: "Connect", exact: true }).last()).toBeVisible(),
      expect(baseline.getByRole("button", { name: "Connect", exact: true }).last()).toBeVisible(),
    ]);
    const controls = async (p: Page) => p.locator("button,input,select,textarea,a").evaluateAll((nodes) => nodes.map((node) => ({ tag: node.tagName, text: node.textContent?.trim(), name: node.getAttribute("aria-label"), placeholder: node.getAttribute("placeholder"), type: node.getAttribute("type") })));
    expect(await controls(page)).toEqual(await controls(baseline));
    const screenshots = await Promise.all([page.screenshot({ path: info.outputPath("current.png"), fullPage: true, animations: "disabled", caret: "hide" }), baseline.screenshot({ path: info.outputPath("baseline-5dded6a.png"), fullPage: true, animations: "disabled", caret: "hide" })]);
    await info.attach("current", { body: screenshots[0], contentType: "image/png" });
    await info.attach("baseline-5dded6a", { body: screenshots[1], contentType: "image/png" });
    expect(screenshots[0].equals(screenshots[1])).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
