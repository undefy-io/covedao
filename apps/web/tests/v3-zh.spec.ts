import { test, expect, type Browser, type Page } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { signPsbtWithKey, signBip322WithKey } from "@crclaunch/wallets/e2e";
import { IDENTITIES, mine, listBtcUtxos } from "./v3-rpc";

/**
 * Simplified Chinese. The language button switches every page, the choice
 * sticks, and a real launch and mint work end to end in Chinese.
 *
 * Named to run after the English journeys, which count holdings.
 */

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";

test.describe.configure({ mode: "serial" });

async function mineAndWait(n = 1) {
  await mine(n);
  for (let i = 0; i < 60; i++) {
    const j = await fetch(`${BASE}/api/v3/status`).then((r) => r.json());
    if (j.ok && j.data.indexer.health === "HEALTHY" && BigInt(j.data.core.height) === BigInt(j.data.indexer.indexedHeight)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("indexer did not catch up after mining");
}

async function walletPage(browser: Browser, identity: { privHex: string; address: string }): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const key = ECPair.fromPrivateKey(Buffer.from(identity.privHex, "hex"), { network: bitcoin.networks.regtest });
  const script = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).output!.toString("hex");
  await page.exposeFunction("__signPsbt", (psbtBase64: string) => signPsbtWithKey(psbtBase64, identity.privHex));
  await page.exposeFunction("__signBip322", (message: string) => signBip322WithKey(message, identity.privHex));
  await page.exposeFunction("__getUtxos", () => listBtcUtxos(identity.address));
  await page.addInitScript(
    ({ address, scriptHex }) => {
      (window as unknown as Record<string, unknown>).__COVE_TEST_WALLET__ = {
        id: "e2e",
        connect: async () => ({ adapterId: "e2e", paymentAddress: address, paymentScript: scriptHex, network: "regtest", capabilities: { psbt: true, bip322Simple: true, p2wpkh: true, p2tr: false, utxoDiscovery: true } }),
        signPsbt: async (p: { psbtBase64: string }) => (window as unknown as { __signPsbt: (s: string) => Promise<string> }).__signPsbt(p.psbtBase64),
        signBip322Simple: async (p: { message: string }) => (window as unknown as { __signBip322: (s: string) => Promise<string> }).__signBip322(p.message),
        getUtxos: async () => (window as unknown as { __getUtxos: () => Promise<unknown> }).__getUtxos(),
      };
    },
    { address: identity.address, scriptHex: script },
  );
  return page;
}

test("ZH-001 the header button switches to Chinese, and the choice sticks", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByText("Covenant-powered", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Switch to Chinese" }).click();
  // Header and homepage hero.
  await expect(page.getByRole("link", { name: "发现", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "市场", exact: true }).first()).toBeVisible();
  await expect(page.getByText("契约驱动的").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  // A fresh load keeps Chinese (cookie), and the server renders it that way.
  await page.reload();
  await expect(page.getByText("契约驱动的").first()).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /发射台/);
  // Market and wallet pages.
  await page.goto(`${BASE}/market`);
  await expect(page.getByText("P2P 挂单").first()).toBeVisible();
  await page.goto(`${BASE}/wallet`);
  await expect(page.getByText("连接钱包查看持仓。")).toBeVisible();
  // And back to English.
  await page.getByRole("button", { name: "切换到英文" }).click();
  await expect(page.getByText("Connect a wallet to view holdings.")).toBeVisible();
});

test("ZH-002 ?lang=zh opens in Chinese; the footer links follow the language", async ({ page }) => {
  await page.goto(`${BASE}/?lang=zh`);
  await expect(page.getByText("契约驱动的").first()).toBeVisible();
  const footer = page.locator("footer");
  await expect(footer.getByRole("link", { name: "文档" })).toHaveAttribute("href", "/docs/zh-Hans/index.html");
  const x = footer.getByRole("link", { name: "covs 的 X" });
  await expect(x).toHaveAttribute("href", "https://x.com/covstrade");
  await expect(x).toHaveAttribute("target", "_blank");
  await expect(x).toHaveAttribute("rel", "noopener noreferrer");
  const tg = footer.getByRole("link", { name: "covs 的 Telegram 群" });
  await expect(tg).toHaveAttribute("href", "https://t.me/covstrade");
  await expect(tg).toHaveAttribute("target", "_blank");
  await expect(tg).toHaveAttribute("rel", "noopener noreferrer");
});

test("ZH-003 English footer links: docs, X and Telegram on every page", async ({ page }) => {
  for (const path of ["/", "/explore", "/launch", "/market", "/wallet", "/activity"]) {
    await page.goto(`${BASE}${path}`);
    const footer = page.locator("footer");
    await expect(footer.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs/index.html");
    await expect(footer.getByRole("link", { name: "covs on X" })).toHaveAttribute("href", "https://x.com/covstrade");
    await expect(footer.getByRole("link", { name: "covs on Telegram" })).toHaveAttribute("href", "https://t.me/covstrade");
  }
});

test("ZH-004 no sideways scroll at 400px, in both languages", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  for (const [lang, button] of [["en", "Switch to Chinese"], ["zh", "切换到英文"]] as const) {
    await page.goto(`${BASE}/?lang=${lang}`);
    for (const path of ["/", "/explore", "/launch", "/market", "/wallet", "/activity"]) {
      await page.goto(`${BASE}${path}`);
      await expect(page.getByRole("button", { name: button })).toBeVisible();
      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(wide, `${lang} ${path}`).toBeLessThanOrEqual(400);
    }
  }
});

test("ZH-005 launch and mint in Chinese", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "mutates the chain; desktop only");
  const page = await walletPage(browser, IDENTITIES.alice);
  await page.goto(`${BASE}/launch?lang=zh`);
  await expect(page.getByRole("heading", { name: "发射代币" })).toBeVisible();
  await page.getByLabel("名称").fill("中文测试币");
  await page.getByLabel(/^代码/).fill("ZHCN");
  await page.getByRole("button", { name: "确认发射信息" }).click();
  await page.getByRole("button", { name: /连接钱包/ }).last().click();
  await page.getByRole("button", { name: "构建、确认并签名" }).click();
  await expect(page.getByText(/已广播/).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const tokens = await fetch(`${BASE}/api/v3/tokens?search=ZHCN`).then((r) => r.json());
  const tokenId = tokens.data[0].tokenId as string;
  expect(tokenId).toMatch(/^[0-9a-f]{64}$/);

  await page.goto(`${BASE}/token/${tokenId}`);
  // The mint tab, in Chinese.
  await expect(page.getByRole("button", { name: "铸造", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "卖回", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /连接钱包/ }).last().click();
  await page.getByLabel("花费 · sats").fill("200000");
  await expect(page.getByText(/≈ .* ZHCN/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "确认铸造" }).click();
  await expect(page.getByText("你正在铸造")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("曲线价格", { exact: true })).toBeVisible();
  await expect(page.getByText("你需支付", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认并签名" }).click();
  await expect(page.getByText(/^铸造成功/).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const detail = await fetch(`${BASE}/api/v3/tokens/${tokenId}`).then((r) => r.json());
  expect(BigInt(detail.data.issuedSupplyAtoms)).toBeGreaterThan(0n);
});
