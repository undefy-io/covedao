import { test, expect, type Browser, type Page } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  twoAddressIdentity,
  signPsbtTwoAddress,
  signBip322P2trWithKey,
} from "@crclaunch/wallets/e2e";
import { IDENTITIES, fund, mine, listBtcUtxos, rpc } from "./v3-rpc";
import { apiListPresigned, waitForListing } from "./v3-list";

/** Every signature per wallet: a presigned seller signs nothing when their listing sells. */
const signCalls = new Map<string, number>();
function countedSign(keys: { payPriv: string; ordPriv: string }, psbtBase64: string): string {
  signCalls.set(keys.ordPriv, (signCalls.get(keys.ordPriv) ?? 0) + 1);
  return signPsbtTwoAddress(psbtBase64, keys.payPriv, keys.ordPriv);
}
const signsBy = (keys: { ordPriv: string }) => signCalls.get(keys.ordPriv) ?? 0;

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

/**
 * The same journey as v3-product, but with wallets shaped like the ones people
 * actually use: Xverse and Magic Eden keep BTC on a nested-segwit address and
 * tokens on a Taproot one. Every signature here is one of those two kinds, so
 * a flow that only works for native segwit fails in this file.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "full journey is desktop-only");
});

const BASE = "http://localhost:3100";
const T = 100_000_000n;

const DAVE = { payPriv: "49".repeat(32), ordPriv: "4a".repeat(32) };
const ERIN = { payPriv: "4b".repeat(32), ordPriv: "4c".repeat(32) };
const dave = twoAddressIdentity(DAVE.payPriv, DAVE.ordPriv);
const erin = twoAddressIdentity(ERIN.payPriv, ERIN.ordPriv);

async function status() {
  return (await fetch(`${BASE}/api/v3/status`)).json();
}

async function mineAndWait(n = 1) {
  await mine(n);
  for (let i = 0; i < 60; i++) {
    const j = await status();
    if (j.ok && j.data.indexer.health === "HEALTHY" && BigInt(j.data.core.height) === BigInt(j.data.indexer.indexedHeight)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("indexer did not catch up after mining");
}

async function portfolio(address: string) {
  return (await fetch(`${BASE}/api/v3/wallet/${address}/portfolio`)).json();
}

async function walletPage(browser: Browser, keys: { payPriv: string; ordPriv: string }): Promise<Page> {
  const id = twoAddressIdentity(keys.payPriv, keys.ordPriv);
  const page = await (await browser.newContext()).newPage();
  await page.exposeFunction("__signPsbt", (psbtBase64: string) => countedSign(keys, psbtBase64));
  // Marketplace messages are signed by the token (ordinals) address.
  await page.exposeFunction("__signBip322", (message: string) => signBip322P2trWithKey(message, keys.ordPriv));
  await page.exposeFunction("__getUtxos", () => listBtcUtxos(id.paymentAddress));
  await page.addInitScript((w) => {
    (window as unknown as Record<string, unknown>).__COVE_TEST_WALLET__ = {
      id: "e2e-two-address",
      connect: async () => ({
        adapterId: "e2e-two-address",
        paymentAddress: w.paymentAddress,
        paymentScript: w.paymentScript,
        paymentPublicKey: w.paymentPublicKey,
        ordinalsAddress: w.ordinalsAddress,
        ordinalsScript: w.ordinalsScript,
        ordinalsPublicKey: w.ordinalsPublicKey,
        network: "regtest",
        capabilities: { psbt: true, bip322Simple: true, p2wpkh: false, p2tr: true, utxoDiscovery: true },
      }),
      signPsbt: async (p: { psbtBase64: string }) => (window as unknown as { __signPsbt: (s: string) => Promise<string> }).__signPsbt(p.psbtBase64),
      signBip322Simple: async (p: { message: string }) => (window as unknown as { __signBip322: (s: string) => Promise<string> }).__signBip322(p.message),
      getUtxos: async () => (window as unknown as { __getUtxos: () => Promise<unknown> }).__getUtxos(),
    };
  }, id);
  return page;
}

let tokenId: string;
let minted: bigint;

/** List through the API (split + Taproot presign) — the UI only offers listing once a token is fully minted. */
async function apiList(keys: { payPriv: string; ordPriv: string }, tokens: bigint, priceSats: number) {
  const id = twoAddressIdentity(keys.payPriv, keys.ordPriv);
  const made = await apiListPresigned(
    {
      fields: {
        walletScript: id.paymentScript, walletAddress: id.paymentAddress, walletPublicKey: id.paymentPublicKey,
        ordinalsScript: id.ordinalsScript, ordinalsPublicKey: id.ordinalsPublicKey,
      },
      tokenAddress: id.ordinalsAddress,
      getUtxos: () => listBtcUtxos(id.paymentAddress),
      sign: (psbt) => countedSign(keys, psbt),
    },
    tokenId,
    tokens * T,
    priceSats,
  );
  if (made.pending) await mineAndWait(1);
  await waitForListing(made.listingId, tokenId);
  return made;
}

test("X-001 launch from a nested-segwit wallet", async ({ browser }) => {
  await fund(dave.paymentAddress, 3);
  await fund(erin.paymentAddress, 3);
  await mineAndWait(1);

  const page = await walletPage(browser, DAVE);
  await page.goto(`${BASE}/launch`);
  await page.getByLabel("Name").fill("Dave Coin");
  await page.getByLabel(/^Ticker/).fill("DAVE");
  await page.getByRole("button", { name: /review launch identity/i }).click();
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: /build, review and sign/i }).click();
  await expect(page.getByText(/broadcast/i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const tokens = await fetch(`${BASE}/api/v3/tokens?search=DAVE`).then((r) => r.json());
  tokenId = tokens.data.find((t: { ticker: string }) => t.ticker === "DAVE").tokenId;
  expect(tokenId).toMatch(/^[0-9a-f]{64}$/);
});

test("X-002 buy lands the tokens on the Taproot address", async ({ browser }) => {
  const page = await walletPage(browser, DAVE);
  await page.goto(`${BASE}/token/${tokenId}`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByLabel(/Spend . sats/i).fill("400000");
  await expect(page.getByText(/≈ .* DAVE/)).toBeVisible({ timeout: 30_000 });
  const q = await fetch(`${BASE}/api/v3/backing/buy/quote-sats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId, budgetSats: "400000" }) }).then((r) => r.json());
  minted = BigInt(q.data.amountAtoms);
  await page.getByRole("button", { name: /review mint/i }).click();
  await expect(page.getByText(/you are minting/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /confirm . sign/i }).click();
  await expect(page.getByText(/^minted\./i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const pf = await portfolio(dave.ordinalsAddress);
  const h = pf.data.holdings.find((x: { tokenId: string }) => x.tokenId === tokenId);
  expect(BigInt(h.amountAtoms)).toBe(minted);
  expect(minted).toBeGreaterThan(20_000n * T);
});

test("X-003 transfer from Taproot to another Taproot wallet", async ({ browser }) => {
  const page = await walletPage(browser, DAVE);
  await page.goto(`${BASE}/wallet`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await page.getByLabel("Send amount").fill("20000");
  await page.getByLabel("Send to address").fill(erin.ordinalsAddress);
  await page.getByRole("button", { name: "Send", exact: true }).last().click();
  await expect(page.getByText(/^sent\./i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const pf = await portfolio(erin.ordinalsAddress);
  const h = pf.data.holdings.find((x: { tokenId: string }) => x.tokenId === tokenId);
  expect(BigInt(h.amountAtoms)).toBe(20_000n * T);
});

test("X-004 sell back to the vault from a Taproot carrier", async ({ browser }) => {
  const page = await walletPage(browser, ERIN);
  await page.goto(`${BASE}/token/${tokenId}`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: "Redeem", exact: true }).click();
  await page.getByLabel(/^Redeem/).fill("10000");
  await page.getByRole("button", { name: /review redeem/i }).click();
  await expect(page.getByText(/you are redeeming/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /confirm . sign/i }).click();
  await expect(page.getByText(/^redeemed\./i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const detail = await fetch(`${BASE}/api/v3/tokens/${tokenId}`).then((r) => r.json());
  expect(BigInt(detail.data.issuedSupplyAtoms)).toBe(minted - 10_000n * T);
});

test("X-005 list with a Taproot SINGLE|ANYONECANPAY presignature", async () => {
  await apiList(DAVE, 3_000n, 50_000);

  const listings = await fetch(`${BASE}/api/v3/market/listings?tokenId=${tokenId}`).then((r) => r.json());
  expect(listings.data.filter((l: { status: string }) => l.status === "ACTIVE").length).toBe(1);
});

test("X-006 P2P fill: nested-segwit buyer, Taproot seller", async ({ browser }) => {
  const listings = await fetch(`${BASE}/api/v3/market/listings?tokenId=${tokenId}`).then((r) => r.json());
  const listingId = listings.data.find((l: { status: string }) => l.status === "ACTIVE").listingId;

  const buyer = await walletPage(browser, ERIN);
  await buyer.goto(`${BASE}/market`);
  await buyer.getByRole("button", { name: /connect wallet/i }).click();
  const daveSignsBefore = signsBy(DAVE);
  await buyer.locator("tr", { hasText: "DAVE" }).getByRole("button", { name: "Buy", exact: true }).first().click();
  await expect(buyer.getByText(/^bought — arrives when/i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);
  // The Taproot seller signed nothing at sale time.
  expect(signsBy(DAVE)).toBe(daveSignsBefore);

  const pf = await portfolio(dave.ordinalsAddress);
  expect(pf.data.listings.find((l: { listingId: string }) => l.listingId === listingId).status).toBe("FILLED");
  const erinPf = await portfolio(erin.ordinalsAddress);
  const h = erinPf.data.holdings.find((x: { tokenId: string }) => x.tokenId === tokenId);
  // 20k transferred − 10k redeemed + 3k bought.
  expect(BigInt(h.amountAtoms)).toBe(13_000n * T);
});

test("X-007 cancel with a Taproot signature", async ({ browser }) => {
  await apiList(DAVE, 2_000n, 40_000);
  const page = await walletPage(browser, DAVE);
  await page.goto(`${BASE}/wallet`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await expect(page.getByText(/listing cancelled/i).first()).toBeVisible({ timeout: 60_000 });
});

test("X-008 a carrier swept by a plain wallet send stops counting as tokens", async () => {
  // Bob (single-address, from v3-product) holds a carrier. Spend it the way any
  // ordinary wallet would, with no Cove envelope at all.
  const bobPf = await portfolio(IDENTITIES.bob.address);
  const carrier = bobPf.data.tokenUtxos?.[0];
  test.skip(!carrier, "no carrier left to sweep");
  const tokenOfCarrier = carrier.tokenId as string;
  const before = await fetch(`${BASE}/api/v3/tokens/${tokenOfCarrier}`).then((r) => r.json());

  const key = ECPair.fromPrivateKey(Buffer.from(IDENTITIES.bob.privHex, "hex"), { network: bitcoin.networks.regtest });
  const script = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).output!;
  const [fee] = await listBtcUtxos(IDENTITIES.bob.address);
  const feeTx = await rpc<{ vout: { n: number; value: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [fee!.txid, true]);
  const feeValue = Math.round(feeTx.vout[fee!.vout]!.value * 1e8);
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({ hash: carrier.txid, index: carrier.vout, witnessUtxo: { script, value: 1000 } });
  psbt.addInput({ hash: fee!.txid, index: fee!.vout, witnessUtxo: { script, value: feeValue } });
  psbt.addOutput({ script, value: feeValue + 1000 - 500 });
  psbt.signAllInputs(key);
  psbt.finalizeAllInputs();
  await rpc("sendrawtransaction", [psbt.extractTransaction().toHex()]);
  await mineAndWait(1);

  const after = await portfolio(IDENTITIES.bob.address);
  expect(after.data.tokenUtxos.find((u: { txid: string; vout: number }) => u.txid === carrier.txid && u.vout === carrier.vout)).toBeUndefined();
  // Burned tokens were issued and stay issued; the curve does not move.
  const detail = await fetch(`${BASE}/api/v3/tokens/${tokenOfCarrier}`).then((r) => r.json());
  expect(detail.data.issuedSupplyAtoms).toBe(before.data.issuedSupplyAtoms);
  const s = await status();
  expect(s.data.indexer.health).toBe("HEALTHY");
});
