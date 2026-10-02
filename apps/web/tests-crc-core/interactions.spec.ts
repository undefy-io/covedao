import { expect, test, type Page } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt } from "@crclaunch/crc20-adapters";
import { fixture, assetId, config, state, key, script, funding, tokenCoin, settle } from "./fixtures";
import { signNativeInput } from "../../../packages/cove-market/crc20-protocol/test-support/signing.js";
const address = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).address!;
async function wallet(page: Page, reject = false, beforeResponse?: () => Promise<void>) {
  const prompts: string[] = [];
  await page.exposeFunction("__crcFixtureSign", async (base64: string, operation: string) => {
    prompts.push(operation); if (reject) throw new Error("User rejected signing");
    await beforeResponse?.();
    const psbt = bitcoin.Psbt.fromBase64(base64);
    psbt.data.inputs.forEach((input, index) => { if (!input.finalScriptWitness && input.witnessUtxo?.script.toString("hex") === script) psbt.signInput(index, key, [input.sighashType ?? 1]); });
    return psbt.toBase64();
  });
  await page.exposeFunction("__crcFixtureMessage", (message: string) => {
    prompts.push("BIP322"); if (reject) throw new Error("User rejected signing");
    const virtual = core.bip322SigningTransaction(script, message);
    const witness = signNativeInput(virtual.tx, virtual.prevouts, 0, key.privateKey!, 1);
    return Buffer.from(core.encodeMessageWitness(witness), "hex").toString("base64");
  });
  await page.addInitScript(({ address, script, publicKey, funding }) => {
    const target = window as unknown as { __COVE_TEST_WALLET__: unknown; __crcFixtureSign: (base64: string, operation: string) => Promise<string>; __crcFixtureMessage: (message: string) => Promise<string> };
    target.__COVE_TEST_WALLET__ = {
      id: "owned-crc-test-wallet", connect: async () => ({ adapterId: "owned-crc-test-wallet", paymentAddress: address, paymentScript: script,
        paymentPublicKey: publicKey, ordinalsAddress: address, ordinalsScript: script, ordinalsPublicKey: publicKey, network: "regtest", capabilities: { psbt: true, bip322Simple: true, p2wpkh: true } }),
      signPsbt: async ({ psbtBase64, operation }: { psbtBase64: string; operation: string }) => target.__crcFixtureSign(psbtBase64, operation),
      signBip322Simple: async ({ message }: { message: string }) => target.__crcFixtureMessage(message),
      getUtxos: async () => [funding],
    };
  }, { address, script, publicKey: key.publicKey.toString("hex"), funding: { txid: funding.txid, vout: funding.vout, valueSats: "20000", confirmations: 1 } });
  return prompts;
}
async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
}
function build(plan: core.Plan, intent: Record<string, unknown>, tamper = false) {
  const transmitted = tamper ? { ...plan, outputs: plan.outputs.map((o, i) => i === 1 ? { ...o, sats: o.sats + 1n } : o) } : plan;
  return { sessionId: "browser-session", psbtBase64: createPlanPsbt(transmitted, "regtest").toBase64(), intent: {
    ...intent, minerFeeSats: Number(plan.minerFeeSats), coreConfig: core.encodeProtocolDto(config), corePlan: core.encodeProtocolDto(plan),
  } };
}
for (const [side, quantity] of [["buy", "500"], ["sell", "400"], ["sell", "600"]] as const) {
  test(`existing trade controls build and sign ${quantity}-token ${side} with exact core fees`, async ({ page }) => {
    await fixture(page); const prompts = await wallet(page); let submitted = 0;
    await page.route(`**/api/crc/v1/backing/${side}/build`, async (route) => {
      const body = route.request().postDataJSON(); expect(body.amountAtoms).toBe((BigInt(quantity) * core.atomsPerToken).toString());
      const args = { state, funding: [funding], inputs: [tokenCoin], amountAtoms: BigInt(body.amountAtoms), recipientScriptHex: script, changeScriptHex: script, minerFeeSats: 400n };
      const plan = side === "buy" ? core.buildMint(args) : core.buildSell(args);
      await route.fulfill({ json: { ok: true, data: build(plan, { operation: side === "buy" ? "mint-buy" : "sell", assetId, amountAtoms: body.amountAtoms, vaultOutpoint: core.outpoint(state.vault), feeTier: "standard" }) } });
    });
    await page.route(`**/api/crc/v1/backing/${side}/submit`, async (route) => {
      const psbt = bitcoin.Psbt.fromBase64(route.request().postDataJSON().signedPsbtBase64);
      expect(psbt.data.inputs[0]!.finalScriptWitness).toBeUndefined();
      expect(psbt.data.inputs.slice(1).every((i) => i.finalScriptWitness)).toBe(true); submitted++;
      await route.fulfill({ json: { ok: true, data: { txid: "ff".repeat(32) } } });
    });
    await page.goto(`/token/${encodeURIComponent(assetId)}`); await settle(page); await connect(page);
    await page.getByRole("button", { name: side === "buy" ? "Buy" : "Sell", exact: true }).click();
    await page.getByRole("textbox", { name: `Tokens to ${side}` }).fill(quantity);
    await page.getByRole("button", { name: `Review ${side}` }).click();
    await page.getByRole("button", { name: "Build trade", exact: true }).click();
    await expect(page.getByText("Exact network fee: 400 sats. Review it before signing.")).toBeVisible();
    await page.getByRole("button", { name: `Sign ${side}` }).click();
    await expect(page.getByText(`Submitted: ${"ff".repeat(32)}`)).toBeVisible();
    expect(prompts).toHaveLength(1); expect(submitted).toBe(1);
  });
}
for (const refusal of ["altered", "unsupported", "rejected"] as const) {
  test(`${refusal} signing never reaches submission and clears busy state`, async ({ page }) => {
    await fixture(page); const prompts = await wallet(page, refusal === "rejected"); let submitted = false;
    await page.route("**/api/crc/v1/backing/buy/build", async (route) => {
      const body = route.request().postDataJSON();
      const plan = core.buildMint({ state, funding: [funding], amountAtoms: BigInt(body.amountAtoms), recipientScriptHex: script, changeScriptHex: script, minerFeeSats: 400n });
      const built = build(plan, { operation: "mint-buy", assetId, amountAtoms: body.amountAtoms, vaultOutpoint: core.outpoint(state.vault), feeTier: "standard" }, refusal === "altered");
      if (refusal === "unsupported") {
        const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
        psbt.data.inputs[1]!.witnessUtxo!.script = Buffer.from("51", "hex");
        built.psbtBase64 = psbt.toBase64();
      }
      await route.fulfill({ json: { ok: true, data: built } });
    });
    await page.route("**/api/crc/v1/backing/buy/submit", async (route) => { submitted = true; await route.fulfill({ status: 500 }); });
    await page.goto(`/token/${encodeURIComponent(assetId)}`); await settle(page); await connect(page);
    await page.getByRole("button", { name: "Review buy" }).click(); await page.getByRole("button", { name: "Build trade" }).click();
    await page.getByRole("button", { name: "Sign buy" }).click();
    await expect(page.getByRole("alert").filter({ hasText: refusal === "rejected" ? "rejected" : "differs" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign buy" })).toBeEnabled();
    expect(submitted).toBe(false); expect(prompts).toHaveLength(refusal === "rejected" ? 1 : 0);
  });
}

test("launch retains metadata review and validates before wallet signing", async ({ page }) => {
  await fixture(page); const prompts = await wallet(page); let submitted = 0;
  await page.route("**/api/crc/v1/launch/build", async (route) => {
    const body = route.request().postDataJSON(); expect(body.ticker).toBe("TEST");
    const plan = core.buildDeploy({ config, funding: [funding], changeScriptHex: script, minerFeeSats: 400n });
    await route.fulfill({ json: { ok: true, data: build(plan, { operation: "deploy", ticker: "TEST", metadata: { displayName: body.metadata.displayName.trim(), description: body.metadata.description.trim(), websiteUrl: body.metadata.websiteUrl.trim() || null, xUrl: body.metadata.xUrl.trim() || null, imageUrl: body.metadata.imageUrl.trim() || null }, feeTier: "standard", vaultAnchorSats: 1000, creatorRecordSats: 1000, launchFeeSats: 7000 }) } });
  });
  await page.route("**/api/crc/v1/launch/submit", async (route) => { submitted++; await route.fulfill({ json: { ok: true, data: { txid: "ff".repeat(32) } } }); });
  await page.goto("/launch"); await settle(page); await connect(page);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Browser Test");
  await page.getByRole("textbox", { name: "Ticker", exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Review launch" }).click();
  await page.getByRole("button", { name: "Build and review transaction" }).click();
  await expect(page.getByText("7000 sats", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign and broadcast launch" }).click();
  await expect(page.getByText(`Submitted: ${"ff".repeat(32)}`)).toBeVisible();
  expect(prompts).toEqual(["CRC_DEPLOY"]); expect(submitted).toBe(1);
});

test("market review completes with one buyer signature and unchanged seller presign", async ({ page }) => {
  const { authorizeOffer } = await import("../../../packages/cove-market/crc20-protocol/test-support/signing.js");
  const offer = await authorizeOffer({ network: "regtest", deployTxid: state.deployTxid, ticker: "TEST", listedInput: tokenCoin,
    sellerScriptHex: script, priceSats: 5000n, expiryHeight: 140 }, key.privateKey!);
  await fixture(page); const prompts = await wallet(page); let submitted = 0;
  await page.route("**/api/crc/v1/market/reserve", async (route) => {
    const body = route.request().postDataJSON(); expect(body.offerId).toBe(core.offerId(offer));
    const plan = core.buildPurchase({ offer, currentHeight: 120, buyerFunding: [funding], buyerScriptHex: script, protocolScriptHex: config.protocolScriptHex, minerFeeSats: 1000n });
    await route.fulfill({ json: { ok: true, data: { ...build(plan, { operation: "purchase", assetId, amountAtoms: tokenCoin.atoms.toString(), offerId: core.offerId(offer) }), fillId: "browser-session" } } });
  });
  await page.route("**/api/crc/v1/market/buyer-sign", async (route) => {
    const psbt = bitcoin.Psbt.fromBase64(route.request().postDataJSON().signedPsbtBase64);
    expect(core.decodeWitness(psbt.data.inputs[0]!.finalScriptWitness!.toString("hex")).map((w) => Buffer.from(w).toString("hex"))).toEqual(offer.sellerWitnessHex);
    submitted++; await route.fulfill({ json: { ok: true, data: { fillId: "browser-session", txid: "ff".repeat(32) } } });
  });
  await page.goto("/market"); await settle(page); await connect(page);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText(`Sale submitted: ${"ff".repeat(32)}`)).toBeVisible();
  expect(prompts).toEqual(["CRC_PURCHASE"]); expect(submitted).toBe(1);
});

test("seller controls publish core BIP322/83 terms and cancellation spends with ALL", async ({ page }) => {
  await fixture(page); const prompts = await wallet(page); let published: core.Offer | undefined, cancelled = 0;
  await page.route("**/api/crc/v1/market/listings", async (route) => {
    if (route.request().method() === "POST") {
      published = core.decodeProtocolDto<core.Offer>(route.request().postDataJSON().offer); core.verifyOffer(published);
      expect(published.listedInput.atoms).toBe(tokenCoin.atoms); expect(published.priceSats).toBe(5000n);
      await route.fulfill({ json: { ok: true, data: { listingId: core.offerId(published) } } }); return;
    }
    const listing = published ? { id: core.offerId(published), network: "regtest", deployTxid: published.deployTxid, ticker: "TEST", sellerScriptHex: script, sellerPayoutScriptHex: script,
      sellerAnchorTxid: tokenCoin.txid, sellerAnchorVout: 0, sellerAnchorSats: 1000, amountAtoms: tokenCoin.atoms.toString(), priceSats: 5000, protocolFeeSats: 1000,
      expiresAtHeight: String(published.expiryHeight), status: "OPEN", coreOffer: core.encodeProtocolDto(published) } : undefined;
    await route.fulfill({ json: { ok: true, data: { active: true, listings: listing ? [listing] : [] } } });
  });
  await page.route("**/api/crc/v1/market/seller-requests", (route) => route.fulfill({ json: { ok: true, data: { requests: [] } } }));
  await page.route("**/api/crc/v1/market/cancel-build", async (route) => {
    expect(published).toBeDefined(); const offer = published!;
    expect(route.request().postDataJSON().offerId).toBe(core.offerId(offer));
    const plan = core.buildCancel({ offer, funding: [funding], changeScriptHex: script, minerFeeSats: 1000n });
    await route.fulfill({ json: { ok: true, data: build(plan, { operation: "cancel", assetId, amountAtoms: tokenCoin.atoms.toString(), offerId: core.offerId(offer) }) } });
  });
  await page.route("**/api/crc/v1/market/cancel", async (route) => {
    const psbt = bitcoin.Psbt.fromBase64(route.request().postDataJSON().signedPsbtBase64);
    expect(core.decodeWitness(psbt.data.inputs[0]!.finalScriptWitness!.toString("hex"))[0]!.at(-1)).toBe(1); cancelled++;
    await route.fulfill({ json: { ok: true, data: { txid: "ff".repeat(32) } } });
  });
  await page.goto("/wallet"); await settle(page); await connect(page);
  await page.getByLabel("Your BTC price (sats)").fill("5000");
  await page.getByRole("button", { name: "Review listing", exact: true }).click();
  await page.getByRole("button", { name: "Sign and create listing", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Listed token output");
  expect(prompts).toEqual(["BIP322", "P2P_LIST"]);
  await page.getByRole("button", { name: "Check buyer requests" }).click();
  expect(prompts).toHaveLength(2);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Listing canceled");
  expect(prompts).toEqual(["BIP322", "P2P_LIST", "CRC_CANCEL"]); expect(cancelled).toBe(1);
});

test("disconnect during independent plan observations prevents a stale wallet prompt", async ({ page }) => {
  await fixture(page); const prompts = await wallet(page); let submitted = false;
  await page.route("**/api/crc/v1/backing/buy/build", async (route) => {
    const body = route.request().postDataJSON();
    const plan = core.buildMint({ state, funding: [funding], amountAtoms: BigInt(body.amountAtoms), recipientScriptHex: script, changeScriptHex: script, minerFeeSats: 400n });
    await route.fulfill({ json: { ok: true, data: build(plan, { operation: "mint-buy", assetId, amountAtoms: body.amountAtoms, vaultOutpoint: core.outpoint(state.vault), feeTier: "standard" }) } });
  });
  await page.route("**/api/crc/v1/backing/buy/submit", async (route) => { submitted = true; await route.fulfill({ status: 500 }); });
  await page.goto(`/token/${encodeURIComponent(assetId)}`); await settle(page); await connect(page);
  await page.getByRole("button", { name: "Review buy" }).click(); await page.getByRole("button", { name: "Build trade" }).click();
  let release!: () => void, observing!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { observing = resolve; });
  await page.route("**/api/crc/v1/wallet/utxos?*", async (route) => {
    observing(); await held;
    await route.fulfill({ json: { ok: true, data: { utxos: [{ txid: funding.txid, vout: 0, valueSats: "20000", confirmations: 1 }] } } });
  });
  await page.getByRole("button", { name: "Sign buy" }).click(); await started;
  await page.getByTitle(`${address} — click to disconnect`).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible(); release();
  await expect(page.getByRole("alert").filter({ hasText: /wallet|connection/i })).toBeVisible();
  expect(prompts).toHaveLength(0); expect(submitted).toBe(false);
});

for (const field of ["description", "websiteUrl", "xUrl", "imageUrl"] as const) {
  test(`launch refuses changed ${field} before offering a signature`, async ({ page }) => {
    await fixture(page); const prompts = await wallet(page);
    await page.route("**/api/crc/v1/launch/build", async (route) => {
      const body = route.request().postDataJSON();
      const plan = core.buildDeploy({ config, funding: [funding], changeScriptHex: script, minerFeeSats: 400n });
      const metadata = { displayName: body.metadata.displayName.trim(), description: "", websiteUrl: null, xUrl: null, imageUrl: null,
        [field]: field === "description" ? "Different description" : "https://different.example" };
      await route.fulfill({ json: { ok: true, data: build(plan, { operation: "deploy", ticker: "TEST", metadata, feeTier: "standard", vaultAnchorSats: 1000, creatorRecordSats: 1000, launchFeeSats: 7000 }) } });
    });
    await page.goto("/launch"); await settle(page); await connect(page);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Browser Test");
    await page.getByRole("textbox", { name: "Ticker", exact: true }).fill("TEST");
    await page.getByRole("button", { name: "Review launch" }).click();
    await page.getByRole("button", { name: "Build and review transaction" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /metadata.*changed/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign and broadcast launch" })).toHaveCount(0);
    expect(prompts).toHaveLength(0);
  });
}

test("disconnect while a wallet response is pending prevents submission of its signature", async ({ page }) => {
  let release!: () => void, signing!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { signing = resolve; });
  await fixture(page); const prompts = await wallet(page, false, async () => { signing(); await held; }); let submitted = false;
  await page.route("**/api/crc/v1/backing/buy/build", async (route) => {
    const body = route.request().postDataJSON();
    const plan = core.buildMint({ state, funding: [funding], amountAtoms: BigInt(body.amountAtoms), recipientScriptHex: script, changeScriptHex: script, minerFeeSats: 400n });
    await route.fulfill({ json: { ok: true, data: build(plan, { operation: "mint-buy", assetId, amountAtoms: body.amountAtoms, vaultOutpoint: core.outpoint(state.vault), feeTier: "standard" }) } });
  });
  await page.route("**/api/crc/v1/backing/buy/submit", async (route) => { submitted = true; await route.fulfill({ status: 500 }); });
  await page.goto(`/token/${encodeURIComponent(assetId)}`); await settle(page); await connect(page);
  await page.getByRole("button", { name: "Review buy" }).click(); await page.getByRole("button", { name: "Build trade" }).click();
  await page.getByRole("button", { name: "Sign buy" }).click(); await started;
  await page.getByTitle(`${address} — click to disconnect`).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible(); release();
  await expect(page.getByRole("alert").filter({ hasText: /wallet|connection/i })).toBeVisible();
  expect(prompts).toHaveLength(1); expect(submitted).toBe(false);
});

test("launch refuses a token carrier substituted into ordinary BTC funding before prompting", async ({ page }) => {
  await fixture(page); const prompts = await wallet(page); let submitted = false;
  await page.route("**/api/crc/v1/launch/build", async (route) => {
    const body = route.request().postDataJSON();
    const disguised = { txid: tokenCoin.txid, vout: tokenCoin.vout, sats: tokenCoin.sats, scriptHex: script };
    const plan = core.buildDeploy({ config, funding: [funding, disguised], changeScriptHex: script, minerFeeSats: 400n });
    await route.fulfill({ json: { ok: true, data: build(plan, { operation: "deploy", ticker: "TEST", metadata: { displayName: body.metadata.displayName.trim(), description: "", websiteUrl: null, xUrl: null, imageUrl: null }, feeTier: "standard", vaultAnchorSats: 1000, creatorRecordSats: 1000, launchFeeSats: 7000 }) } });
  });
  await page.route("**/api/crc/v1/launch/submit", async (route) => { submitted = true; await route.fulfill({ status: 500 }); });
  await page.goto("/launch"); await settle(page); await connect(page);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Browser Test");
  await page.getByRole("textbox", { name: "Ticker", exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Review launch" }).click();
  await page.getByRole("button", { name: "Build and review transaction" }).click();
  await page.getByRole("button", { name: "Sign and broadcast launch" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /funding contains a token carrier/i })).toBeVisible();
  expect(prompts).toHaveLength(0); expect(submitted).toBe(false);
});
