import { expect, test, type Page } from "@playwright/test";
import { crcCoreStateRoot } from "@crclaunch/crc20-state";
import * as core from "@crclaunch/crc20-protocol";
import * as bitcoin from "bitcoinjs-lib";
import { signNativeInput } from "../../../packages/cove-market/crc20-protocol/test-support/signing.js";
import { CrcChainHarness, alice, bob } from "./harness";

test.describe.configure({ mode: "serial" });
const harness = new CrcChainHarness();
let deployTxid: string;
test.beforeAll(async () => { test.setTimeout(180_000); await harness.start(); });
test.beforeEach(async () => { await harness.observeFees(); });
test.afterAll(async () => { test.setTimeout(30_000); await harness.close(); });
async function connected(page: Page, actor = alice, path = "/wallet") {
  await harness.wallet(page, actor);
  await page.goto(harness.url + path);
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => Boolean((window as unknown as { __COVE_TEST_WALLET__?: unknown }).__COVE_TEST_WALLET__))).toBe(true);
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
}
async function prepareTrade(page: Page, side: "buy" | "sell", quantity: string) {
  await page.goto(harness.url + `/token/${encodeURIComponent(`regtest:${deployTxid}`)}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Chain proof", exact: true })).toBeVisible();
  await page.getByRole("button", { name: side === "buy" ? "Buy" : "Sell", exact: true }).click();
  await page.getByRole("textbox", { name: `Tokens to ${side}` }).fill(quantity);
  await page.getByRole("button", { name: `Review ${side}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Build trade", exact: true })).toBeEnabled();
  const builtResponse = page.waitForResponse((r) => r.url().endsWith(`/backing/${side}/build`));
  await page.getByRole("button", { name: "Build trade", exact: true }).click();
  const built = await (await builtResponse).json(); expect(built.ok, JSON.stringify(built)).toBe(true);
  const plan = core.decodeProtocolDto<core.Plan>(built.data.intent.corePlan);
  await expect(page.getByText(`Exact network fee: ${plan.minerFeeSats.toLocaleString("en-US")} sats. Review it before signing.`)).toBeVisible();
  return built.data;
}
async function trade(page: Page, side: "buy" | "sell", quantity: string) {
  const built = await prepareTrade(page, side, quantity);
  const submittedResponse = page.waitForResponse((r) => r.url().endsWith(`/backing/${side}/submit`));
  await page.getByRole("button", { name: `Sign ${side}`, exact: true }).click();
  const submitted = await (await submittedResponse).json(); expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  await expect(page.getByText(`Submitted: ${submitted.data.txid}`)).toBeVisible();
  await harness.mineAndVerify(submitted.data.txid, built);
  return built;
}

test("unchanged launch controls prepare, sign, register and mine an actual deployment", async ({ page }) => {
  await connected(page, alice, "/launch");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Chain proof");
  await page.getByRole("textbox", { name: "Ticker", exact: true }).fill("CHAIN");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Owned regtest browser proof");
  await page.getByRole("button", { name: "Review launch", exact: true }).click();
  const builtResponse = page.waitForResponse((r) => r.url().endsWith("/launch/build"));
  await page.getByRole("button", { name: "Build and review transaction", exact: true }).click();
  const built = await (await builtResponse).json(); expect(built.ok, JSON.stringify(built)).toBe(true);
  await harness.initialize(core.decodeProtocolDto<core.Config>(built.data.intent.coreConfig));
  await expect(page.getByText("7000 sats", { exact: true })).toBeVisible();
  const submitResponse = page.waitForResponse((r) => r.url().endsWith("/launch/submit"));
  await page.getByRole("button", { name: "Sign and broadcast launch", exact: true }).click();
  const refusal = page.getByRole("alert").filter({ hasText: /\S/ });
  const response = await Promise.race([submitResponse, refusal.waitFor({ state: "visible" }).then(async () => { throw new Error(`Browser refused launch: ${await refusal.allTextContents()}`); })]);
  const result = await response.json(); expect(result.ok, JSON.stringify(result)).toBe(true);
  deployTxid = result.data.txid;
  await harness.mineAndVerify(deployTxid, built.data);
  expect(harness.ledger!.assets[deployTxid]!.issuedAtoms).toBe(0n);
  expect(harness.prompts.map((p) => p.operation)).toEqual(["CRC_DEPLOY"]);
});

test("browser 500+500 mint, 400+600 sell, inventory buy and 1000 sell agree with raw chain and durable state", async ({ page }) => {
  await connected(page);
  await trade(page, "buy", "500"); await trade(page, "buy", "500");
  expect(harness.ledger!.assets[deployTxid]!.issuedAtoms).toBe(1000n * core.atomsPerToken);
  await trade(page, "sell", "400"); await trade(page, "sell", "600");
  expect(harness.ledger!.assets[deployTxid]!.inventoryAtoms).toBe(1000n * core.atomsPerToken);
  const inventory = await trade(page, "buy", "1000");
  expect(inventory.intent.operation).toBe("inventory-buy");
  await trade(page, "sell", "1000");
  expect(harness.ledger!.assets[deployTxid]!.issuedAtoms).toBe(1000n * core.atomsPerToken);
  expect(harness.ledger!.assets[deployTxid]!.inventoryAtoms).toBe(1000n * core.atomsPerToken);
});

async function tokenOperation(page: Page, owner: typeof alice, operation: "listing" | "transfer", amountAtoms: bigint, recipientScriptHex = owner.ordinalsScript) {
  const bitcoin = await harness.json(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(owner.address)}`);
  const token = await harness.json(`/api/crc/v1/tokens/${encodeURIComponent(`regtest:${deployTxid}`)}/utxos?address=${encodeURIComponent(owner.ordinalsAddress)}`);
  const outpoints = (rows: { txid: string; vout: number }[]) => rows.map(({ txid, vout }) => ({ txid, vout }));
  const built = await harness.json(`/api/crc/v1/market/${operation}-build`, { walletScriptHex: owner.script, tokenScriptHex: owner.ordinalsScript,
    walletPublicKeyHex: owner.publicKey, tokenPublicKeyHex: owner.publicKey, paymentFunding: outpoints(bitcoin.utxos), tokenFunding: outpoints(token.utxos),
    deployTxid, amountAtoms: amountAtoms.toString(), recipientScriptHex, ...(operation === "listing" ? { priceSats: "5000" } : {}),
    minerFeeSats: 1000, idempotencyKey: crypto.randomUUID() });
  const signedPsbtBase64 = await harness.reviewInBrowser(page, built, { operation, assetId: `regtest:${deployTxid}`, amountAtoms: amountAtoms.toString(),
    recipientScriptHex, ...(operation === "listing" ? { priceSats: "5000" } : {}), minerFeeSats: 1000 }, owner);
  const result = await harness.json(`/api/crc/v1/market/${operation}-submit`, { sessionId: built.sessionId, signedPsbtBase64 });
  await harness.mineAndVerify(result.txid, built); return { built, result, signedPsbtBase64 };
}
async function publish(page: Page, owner: typeof alice, atoms: bigint, price = "5000", expiry = "12") {
  await page.goto(harness.url + "/wallet"); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  const coin = Object.entries(harness.ledger!.allocations).find(([, allocation]) => allocation.deployTxid === deployTxid && allocation.scriptHex === owner.ordinalsScript && allocation.atoms === atoms);
  expect(coin).toBeDefined();
  await page.getByRole("combobox").filter({ has: page.locator(`option[value="regtest:${deployTxid}"]`) }).selectOption(`regtest:${deployTxid}`);
  await expect(page.getByLabel("Whole token output")).toBeVisible();
  await page.getByLabel("Whole token output").selectOption(coin![0]);
  await page.getByLabel("Your BTC price (sats)").fill(price); await page.getByLabel("Expiry (blocks)").fill(expiry);
  await page.getByRole("button", { name: "Review listing", exact: true }).click();
  const response = page.waitForResponse((r) => r.url().endsWith("/market/listings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign and create listing", exact: true }).click();
  const result = await (await response).json(); expect(result.ok, JSON.stringify(result)).toBe(true);
  const book = await harness.json("/api/crc/v1/market/listings");
  const listing = book.listings.find((row: { id: string }) => row.id === result.data.listingId); expect(listing).toBeDefined(); return listing;
}
async function purchase(page: Page, listing: { id: string; sellerAnchorTxid: string; sellerAnchorVout: number; coreOffer: unknown }) {
  await page.goto(harness.url + "/market"); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  const row = page.locator("tbody tr").filter({ hasText: `${listing.sellerAnchorTxid.slice(0, 12)}:${listing.sellerAnchorVout}` });
  const builtResponse = page.waitForResponse((r) => r.url().endsWith("/market/reserve"));
  const submittedResponse = page.waitForResponse((r) => r.url().endsWith("/market/buyer-sign"));
  const before = harness.prompts.length;
  await row.getByRole("button", { name: "Review", exact: true }).click();
  const built = await (await builtResponse).json(); expect(built.ok, JSON.stringify(built)).toBe(true);
  const result = await (await submittedResponse).json(); expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(harness.prompts.slice(before).map((p) => p.operation)).toEqual(["CRC_PURCHASE"]);
  await expect(page.getByText(`Sale submitted: ${result.data.txid}`)).toBeVisible();
  await harness.mineAndVerify(result.data.txid, built.data);
  const offer = core.decodeProtocolDto<core.Offer>(listing.coreOffer);
  expect(core.parseRawTransaction(harness.node.rpc("getrawtransaction", [result.data.txid])).inputs[0]!.witness.map((item) => Buffer.from(item).toString("hex"))).toEqual(offer.sellerWitnessHex);
}

test("1500/500 listings split on-chain and unchanged controls fill with only a nested-payment/Taproot-token buyer", async ({ page, context }) => {
  await connected(page); await trade(page, "buy", "1000"); await trade(page, "buy", "1000");
  await tokenOperation(page, alice, "listing", 1500n * core.atomsPerToken);
  await tokenOperation(page, alice, "listing", 500n * core.atomsPerToken);
  const ask1500 = await publish(page, alice, 1500n * core.atomsPerToken);
  const ask500 = await publish(page, alice, 500n * core.atomsPerToken, "6000");
  const buyer = await context.newPage(); await harness.wallet(buyer, bob);
  await purchase(buyer, ask500); await purchase(buyer, ask1500);
  const holdings = Object.values(harness.ledger!.allocations).filter((a) => a.scriptHex === bob.ordinalsScript).reduce((n, a) => n + a.atoms, 0n);
  expect(holdings).toBe(2000n * core.atomsPerToken);
  await buyer.close();
});

test("browser service transfers one atom, Taproot seller publishes fractional terms and cancellation mines ALL signatures", async ({ page }) => {
  await connected(page, bob);
  await tokenOperation(page, bob, "transfer", 1n);
  const listing = await publish(page, bob, 1n);
  expect(listing.amountAtoms).toBe("1");
  const beforeRoot = crcCoreStateRoot(await harness.sync());
  const before = harness.prompts.length;
  const builtResponse = page.waitForResponse((r) => r.url().endsWith("/market/cancel-build"));
  const resultResponse = page.waitForResponse((r) => r.url().endsWith("/market/cancel"));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const built = await (await builtResponse).json(); expect(built.ok, JSON.stringify(built)).toBe(true);
  const result = await (await resultResponse).json(); expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(harness.prompts.slice(before).map((p) => p.operation)).toEqual(["CRC_CANCEL"]);
  await harness.mineAndVerify(result.data.txid, built.data);
  await expect(page.getByRole("status")).toHaveText("Listing canceled");
  expect(harness.ledger!.offers[listing.id]!.status).toBe("cancelled");
  const afterRoot = crcCoreStateRoot(harness.ledger!);
  const economicState = (ledger: core.Ledger) => ({ ...core.snapshotLedger(ledger), tip: null });
  const expectedEconomicState = economicState(harness.ledger!);
  const custody = harness.backend.signatures;
  const orphan = harness.ledger!.tip!.hash;
  await harness.stopWeb(); await harness.startWeb();
  const receiptBody = { sessionId: built.data.sessionId, signedPsbtBase64: "saved receipt retry" };
  expect(await harness.json("/api/crc/v1/market/cancel", receiptBody)).toEqual(result.data);
  expect(crcCoreStateRoot(await harness.sync())).toBe(afterRoot);
  harness.node.rpc("invalidateblock", [orphan]); harness.node.clearOrphanMempool();
  expect(crcCoreStateRoot(await harness.sync())).toBe(beforeRoot);
  expect((await harness.database.pool.query("select txid from crc_events where txid=$1", [result.data.txid])).rows).toHaveLength(0);
  expect(await harness.json("/api/crc/v1/market/cancel", receiptBody)).toEqual(result.data);
  await harness.mineAndVerify(result.data.txid, built.data);
  // A replacement block has a different hash; economic state and allocations must match.
  expect(economicState(harness.ledger!)).toEqual(expectedEconomicState);
  expect(harness.ledger!.offers[listing.id]!.status).toBe("cancelled");
  expect(harness.backend.signatures).toBe(custody);
  harness.evidence.push({ restartReorg: { txid: result.data.txid, beforeRoot, afterRoot, restoredBeforeRoot: beforeRoot, restoredAfterRoot: crcCoreStateRoot(harness.ledger!) } });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
test("competing browser builds have one winner and spent-vault rejection precedes second custody", async ({ page, browser }) => {
  await connected(page);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage(); await connected(other, bob);
  const winner = await prepareTrade(page, "buy", "500");
  const loser = await prepareTrade(other, "buy", "500");
  expect(winner.intent.vaultOutpoint).toBe(loser.intent.vaultOutpoint);
  const entered = signal(), release = signal();
  harness.onWalletResponse = async (operation, owner) => {
    if (operation === "CRC_BUY" && owner === bob) { entered.resolve(); await release.promise; }
  };
  try {
    const rejected = other.waitForResponse((r) => r.url().endsWith("/backing/buy/submit"));
    await other.getByRole("button", { name: "Sign buy", exact: true }).click();
    await entered.promise;
    const accepted = page.waitForResponse((r) => r.url().endsWith("/backing/buy/submit"));
    await page.getByRole("button", { name: "Sign buy", exact: true }).click();
    const first = await (await accepted).json(); expect(first.ok, JSON.stringify(first)).toBe(true);
    const signatures = harness.backend.signatures;
    release.resolve();
    const second = await (await rejected).json();
    expect(second).toMatchObject({ ok: false, error: { code: "STATE_CHANGED" } });
    expect(harness.backend.signatures).toBe(signatures);
    await expect(other.getByRole("alert").filter({ hasText: /confirmed matching UTXO/ })).toBeVisible();
    await harness.mineAndVerify(first.data.txid, winner);
    expect(harness.node.rpc("getrawmempool")).toEqual([]);
    harness.evidence.push({ competition: { winner: first.data.txid, losingSession: loser.sessionId, refusal: second, custodySignatures: signatures } });
  } finally { release.resolve(); harness.onWalletResponse = undefined; await otherContext.close(); }
});

test("a browser-reviewed paid presign settles after expiry while a fresh expired purchase refuses", async ({ page, browser }) => {
  await connected(page, bob);
  const listing = await publish(page, bob, 1n, "5000", "1");
  const otherContext = await browser.newContext();
  const buyer = await otherContext.newPage(); await harness.wallet(buyer, alice);
  const entered = signal(), release = signal();
  harness.onWalletResponse = async (operation, owner) => {
    if (operation === "CRC_PURCHASE" && owner === alice) { entered.resolve(); await release.promise; }
  };
  try {
    const fill = purchase(buyer, listing);
    await entered.promise;
    harness.node.mine(); await harness.sync();
    expect(harness.ledger!.tip!.height).toBe(Number(listing.expiresAtHeight));
    const funding = await harness.json(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(alice.address)}`);
    const checked = await harness.json("/api/crc/v1/market/funding-check", {
      outpoints: funding.utxos.map(({ txid, vout }: { txid: string; vout: number }) => ({ txid, vout })),
    });
    const expired = await fetch(harness.url + "/api/crc/v1/market/reserve", {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": "127.0.0.5" },
      body: JSON.stringify({ offerId: listing.id, walletScriptHex: alice.script, tokenScriptHex: alice.ordinalsScript,
        walletPublicKeyHex: alice.publicKey, tokenPublicKeyHex: alice.publicKey, minerFeeSats: 1000,
        paymentFunding: checked.tokenFreeOutpoints, idempotencyKey: crypto.randomUUID() }),
    });
    const refusal = await expired.json(); expect(expired.status).toBe(400);
    expect(refusal).toMatchObject({ ok: false, error: { code: "STATE_CHANGED" } });
    expect(JSON.stringify(refusal)).toMatch(/expired/i);
    release.resolve(); await fill;
    expect(harness.ledger!.offers[listing.id]!.status).toBe("filled");
    harness.evidence.push({ delayedExpiry: { offerId: listing.id, expiryHeight: listing.expiresAtHeight, confirmedHeight: harness.ledger!.tip!.height, newBuildRefusal: refusal } });
  } finally { release.resolve(); harness.onWalletResponse = undefined; await otherContext.close(); }
});

test("actual browser/HTTP boundaries reject changed PSBT, token-as-BTC funding and re-signed wrong presign", async ({ page }) => {
  await connected(page);
  const listing = await publish(page, alice, 500n * core.atomsPerToken);
  const offer = core.decodeProtocolDto<core.Offer>(listing.coreOffer);
  const built = await prepareTrade(page, "buy", "500");
  const changed = bitcoin.Psbt.fromBase64(built.psbtBase64); changed.setVersion(3);
  const prompts = harness.prompts.length, signatures = harness.backend.signatures;
  await expect(harness.reviewInBrowser(page, { ...built, psbtBase64: changed.toBase64() }, {
    operation: "buy", assetId: `regtest:${deployTxid}`, amountAtoms: (500n * core.atomsPerToken).toString(), minerFeeSats: built.intent.minerFeeSats,
  }, alice)).rejects.toThrow(/PSBT|transaction/i);
  expect(harness.prompts).toHaveLength(prompts);
  const post = async (path: string, body: unknown) => (await fetch(harness.url + path, { method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "127.0.0.6" }, body: JSON.stringify(body) })).json();
  const tokenFunding = await post("/api/crc/v1/backing/buy/build", {
    assetId: `regtest:${deployTxid}`, amountAtoms: (500n * core.atomsPerToken).toString(), walletAddress: alice.address,
    ordinalsAddress: alice.ordinalsAddress, walletPublicKey: alice.publicKey, ordinalsPublicKey: alice.publicKey,
    paymentFunding: [{ txid: offer.listedInput.txid, vout: offer.listedInput.vout }], feeTier: "standard", idempotencyKey: crypto.randomUUID(),
  });
  expect(tokenFunding.ok).toBe(false);
  expect(["FUNDING_INPUT_INVALID", "INSUFFICIENT_BTC"]).toContain(tokenFunding.error.code);
  const wrong = core.offerSigningTransaction(offer);
  wrong.outputs[0]!.sats++;
  const witness = signNativeInput(wrong, [offer.listedInput], 0, alice.key.privateKey!, 131);
  const presign = await post("/api/crc/v1/market/listings", { offer: core.encodeProtocolDto({ ...offer, sellerWitnessHex: witness }) });
  expect(presign).toMatchObject({ ok: false, error: { code: "WALLET_SIGNATURE_INVALID" } });
  const terms = await post("/api/crc/v1/market/listings", { offer: { ...listing.coreOffer, priceSats: "5001" } });
  expect(terms).toMatchObject({ ok: false, error: { code: "WALLET_SIGNATURE_INVALID" } });
  expect(harness.backend.signatures).toBe(signatures);
  harness.evidence.push({ rejectedTampering: { sessionId: built.sessionId, tokenFunding, presign, terms, noAdditionalWalletPrompts: true, noAdditionalCustody: true } });
});

test("one browser buy400/sell400/buy1000 then100 and list300 keeps full receipts without manual refresh", async ({ page, context }) => {
  await connected(page,alice,"/launch");
  await page.getByRole("textbox",{name:"Name",exact:true}).fill("Chain proof");
  await page.getByRole("textbox",{name:"Ticker",exact:true}).fill("INVB");
  await page.getByRole("button",{name:"Review launch",exact:true}).click();
  const building=page.waitForResponse(r=>r.url().endsWith("/launch/build"));
  await page.getByRole("button",{name:"Build and review transaction",exact:true}).click();
  const built=(await (await building).json()).data;
  const submitting=page.waitForResponse(r=>r.url().endsWith("/launch/submit"));
  await page.getByRole("button",{name:"Sign and broadcast launch",exact:true}).click();
  const result=await (await submitting).json(); expect(result.ok,JSON.stringify(result)).toBe(true);
  deployTxid=result.data.txid; await harness.mineAndVerify(deployTxid,built);
  await trade(page,"buy","400"); await trade(page,"sell","400");
  const buyer=await context.newPage(); await harness.wallet(buyer,bob);
  const prompts=harness.prompts.length;
  const mixed=await trade(buyer,"buy","1000");
  expect(harness.prompts.length).toBe(prompts+1);
  expect(mixed.intent).toMatchObject({operation:"mint-buy",amountAtoms:"100000000000",inventoryBuyAtoms:"40000000000",newlyMintedAtoms:"60000000000"});
  expect(harness.ledger!.assets[deployTxid]).toMatchObject({issuedAtoms:1000n*core.atomsPerToken,inventoryAtoms:0n});
  await expect(buyer.getByRole("cell",{name:"1,000",exact:true}).first()).toBeVisible({timeout:15_000});
  const activity=await harness.json(`/api/crc/v1/tokens/${encodeURIComponent(`regtest:${deployTxid}`)}/activity`);
  expect(activity.rows[0]).toMatchObject({amountAtoms:"100000000000",inventoryBuyAtoms:"40000000000",newlyMintedAtoms:"60000000000"});
  await trade(buyer,"buy","100");
  await tokenOperation(buyer,bob,"listing",300n*core.atomsPerToken);
  const ask=await publish(buyer,bob,300n*core.atomsPerToken);
  await purchase(page,ask);
  const bobAtoms=Object.values(harness.ledger!.allocations).filter(a=>a.deployTxid===deployTxid&&a.scriptHex===bob.ordinalsScript).reduce((n,a)=>n+a.atoms,0n);
  expect(bobAtoms).toBe(800n*core.atomsPerToken);
  expect(harness.ledger!.assets[deployTxid]!.issuedAtoms).toBe(1100n*core.atomsPerToken);
  await buyer.close();
});
