import { test, expect, type Browser, type Page } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { signPsbtWithKey, signBip322WithKey } from "@crclaunch/wallets/e2e";
import { IDENTITIES, mine, listBtcUtxos, rpc } from "./v3-rpc";
import { apiListPresigned, waitForListing } from "./v3-list";

/**
 * Every wallet signature, per identity. A presigned listing's seller signs
 * once, at listing time; these counts prove nothing is asked of them when
 * the listing sells.
 */
const signCalls = new Map<string, number>();
function countedSign(privHex: string, psbtBase64: string): string {
  signCalls.set(privHex, (signCalls.get(privHex) ?? 0) + 1);
  return signPsbtWithKey(psbtBase64, privHex);
}
const signsBy = (id: { privHex: string }) => signCalls.get(id.privHex) ?? 0;

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

test.describe.configure({ mode: "serial" });

// The full journey mutates shared on-chain state and must run exactly once —
// desktop only. Mobile coverage is a separate read-only smoke spec.
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "full product journey is desktop-only");
});

const BASE = "http://localhost:3100";

async function status() {
  const r = await fetch(`${BASE}/api/v3/status`);
  return r.json();
}

async function mineAndWait(n = 1) {
  await mine(n);
  // Wait for the V3 worker to catch up (indexer height == Core height).
  for (let i = 0; i < 60; i++) {
    const j = await status();
    if (j.ok && j.data.indexer.health === "HEALTHY" && BigInt(j.data.core.height) === BigInt(j.data.indexer.indexedHeight)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("indexer did not catch up after mining");
}

function scriptOf(privHex: string): string {
  const key = ECPair.fromPrivateKey(Buffer.from(privHex, "hex"), { network: bitcoin.networks.regtest });
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).output!.toString("hex");
}

async function walletPage(browser: Browser, identity: { privHex: string; address: string }): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const script = scriptOf(identity.privHex);
  await page.exposeFunction("__signPsbt", (psbtBase64: string) => countedSign(identity.privHex, psbtBase64));
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

let aliceTokenId: string;
/** What Alice's mint actually produced; later steps count from it. */
let minted: bigint;
const T = 100_000_000n;

/** List through the API (split + presign) — the UI only offers listing once a token is fully minted. */
async function apiList(identity: { privHex: string; address: string }, tokenId: string, tokens: bigint, priceSats: number) {
  const script = scriptOf(identity.privHex);
  const made = await apiListPresigned(
    {
      fields: { walletScript: script, walletAddress: identity.address },
      tokenAddress: identity.address,
      getUtxos: () => listBtcUtxos(identity.address),
      sign: (psbt) => countedSign(identity.privHex, psbt),
    },
    tokenId,
    tokens * T,
    priceSats,
  );
  return made;
}

test("E2E-001 launch: Alice launches FROG through the UI", async ({ browser }) => {
  const page = await walletPage(browser, IDENTITIES.alice);
  await page.goto(`${BASE}/launch`);
  await page.getByLabel("Name").fill("E2E Frog");
  await page.getByLabel(/^Ticker/).fill("FROG");

  // connect
  await page.getByRole("button", { name: /review launch identity/i }).click();
  // review panel appears with tokenId
  const tokenIdEl = page.locator("text=Review").locator("..").locator("text=/^[0-9a-f]{64}$/").first();
  // The tokenId is shown in the review panel; capture it via the API after build.
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: /build, review and sign/i }).click();
  // after sign+broadcast the page shows the txid + token link
  await expect(page.getByText(/broadcast/i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  // confirm token appears
  const tokens = await fetch(`${BASE}/api/v3/tokens?search=FROG`).then((r) => r.json());
  expect(tokens.data.length).toBeGreaterThanOrEqual(1);
  aliceTokenId = tokens.data[0].tokenId;
  expect(aliceTokenId).toMatch(/^[0-9a-f]{64}$/);

  // The launch paid the 7,000-sat launch fee (~$6) to the protocol fee address
  // at output 3: the regtest fee key's address (the public 0x44 fixture key).
  const detail = await fetch(`${BASE}/api/v3/tokens/${aliceTokenId}`).then((r) => r.json());
  const deployTx = await rpc<{ vout: { value: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [detail.data.deployTxid, true]);
  const feeScriptHex = bitcoin.payments
    .p2wpkh({ pubkey: ECPair.fromPrivateKey(Buffer.alloc(32, 0x44)).publicKey, network: bitcoin.networks.regtest })
    .output!.toString("hex");
  expect(Math.round(deployTx.vout[3]!.value * 1e8)).toBe(7_000);
  expect(deployTx.vout[3]!.scriptPubKey.hex).toBe(feeScriptHex);
});

test("E2E-002 mint: Alice mints by spending sats", async ({ browser }) => {
  const page = await walletPage(browser, IDENTITIES.alice);
  await page.goto(`${BASE}/token/${aliceTokenId}`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  // Before mint-out the only trades are with the curve.
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveCount(0);
  // The first quick button is the smallest mint that works right now, and it
  // really does mint something.
  const zero = await fetch(`${BASE}/api/v3/backing/buy/quote-sats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: aliceTokenId, budgetSats: "0" }) }).then((r) => r.json());
  const minSpend = BigInt(zero.data.minSpendSats);
  const minLabel = minSpend.toLocaleString("en-US");
  await page.getByRole("button", { name: minLabel, exact: true }).click();
  await expect(page.getByLabel(/Spend . sats/i)).toHaveValue(minSpend.toString());
  await expect(page.getByText(/≈ 1K FROG/)).toBeVisible({ timeout: 30_000 });
  const one = await fetch(`${BASE}/api/v3/backing/buy/quote-sats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: aliceTokenId, budgetSats: (minSpend - 1n).toString() }) }).then((r) => r.json());
  expect(one.data.amountAtoms).toBe("0"); // one sat less mints nothing

  await page.getByLabel(/Spend . sats/i).fill("200000");
  await expect(page.getByText(/≈ .* FROG/)).toBeVisible({ timeout: 30_000 });
  const q = await fetch(`${BASE}/api/v3/backing/buy/quote-sats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: aliceTokenId, budgetSats: "200000" }) }).then((r) => r.json());
  minted = BigInt(q.data.amountAtoms);
  expect(minted).toBeGreaterThan(10_000n * T);
  expect(minted % (1_000n * T)).toBe(0n); // whole lots
  // A budget below one lot (the flat fee alone is 5,000 sats) quotes nothing, not a 500.
  const tiny = await fetch(`${BASE}/api/v3/backing/buy/quote-sats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: aliceTokenId, budgetSats: "100" }) }).then((r) => r.json());
  expect(tiny.ok).toBe(true);
  expect(tiny.data.amountAtoms).toBe("0");
  // Two steps on purpose: the price, the protocol fee and the network fee are
  // on screen before anything is built or signed.
  await page.getByRole("button", { name: /review mint/i }).click();
  await expect(page.getByText(/you are minting/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Curve price", { exact: true })).toBeVisible();
  await expect(page.getByText(/^you pay$/i)).toBeVisible();
  await page.getByRole("button", { name: /confirm . sign/i }).click();
  await expect(page.getByText(/^minted\./i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const detail = await fetch(`${BASE}/api/v3/tokens/${aliceTokenId}`).then((r) => r.json());
  expect(BigInt(detail.data.issuedSupplyAtoms)).toBe(minted);
  const pf = await fetch(`${BASE}/api/v3/wallet/${IDENTITIES.alice.address}/portfolio`).then((r) => r.json());
  expect(pf.data.holdings.length).toBe(1);
});

test("E2E-003 transfer: Alice transfers to Bob (backing + supply unchanged)", async ({ browser }) => {
  const page = await walletPage(browser, IDENTITIES.alice);
  await page.goto(`${BASE}/wallet`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await page.getByLabel("Send amount").fill("10000");
  await page.getByLabel("Send to address").fill(IDENTITIES.bob.address);
  await page.getByRole("button", { name: "Send", exact: true }).last().click();
  await expect(page.getByText(/^sent\./i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const pf = await fetch(`${BASE}/api/v3/wallet/${IDENTITIES.bob.address}/portfolio`).then((r) => r.json());
  expect(pf.data.holdings.length).toBe(1);
  const detail = await fetch(`${BASE}/api/v3/tokens/${aliceTokenId}`).then((r) => r.json());
  // supply unchanged by a transfer
  expect(BigInt(detail.data.issuedSupplyAtoms)).toBe(minted);
});

test("E2E-004 redeem: Bob instant-sells to Cove Backing", async ({ browser }) => {
  const page = await walletPage(browser, IDENTITIES.bob);
  await page.goto(`${BASE}/token/${aliceTokenId}`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: "Redeem", exact: true }).click();
  await page.getByLabel(/^Redeem/).fill("10000");
  await page.getByRole("button", { name: /review redeem/i }).click();
  await expect(page.getByText(/you are redeeming/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^you receive$/i)).toBeVisible();
  await page.getByRole("button", { name: /confirm . sign/i }).click();
  await expect(page.getByText(/^redeemed\./i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  const detail = await fetch(`${BASE}/api/v3/tokens/${aliceTokenId}`).then((r) => r.json());
  expect(BigInt(detail.data.issuedSupplyAtoms)).toBe(minted - 10_000n * T);
});

test("E2E-005 list P2P: Alice splits off 1,000 and presigns it (PENDING → ACTIVE)", async () => {
  const before = signsBy(IDENTITIES.alice);
  const { listingId, pending } = await apiList(IDENTITIES.alice, aliceTokenId, 1_000n, 100_000);
  // Two signatures: the split, and the one presignature. Nothing else, ever.
  expect(signsBy(IDENTITIES.alice) - before).toBe(2);
  expect(pending).toBe(true);
  // Not buyable until the split confirms.
  const hidden = await fetch(`${BASE}/api/v3/market/listings`).then((r) => r.json());
  expect(hidden.data.some((l: { listingId: string }) => l.listingId === listingId)).toBe(false);
  await mineAndWait(1);
  await waitForListing(listingId, aliceTokenId);
  const listings = await fetch(`${BASE}/api/v3/market/listings`).then((r) => r.json());
  expect(listings.data.length).toBe(1);
  expect(listings.data[0].status).toBe("ACTIVE");
  // The seller's presignature is never served.
  expect(JSON.stringify(listings.data)).not.toMatch(/sellerPresignedPsbt|cHNidP8/);
});

test("E2E-006 P2P buy: Bob buys and it settles with no seller signature", async ({ browser }) => {
  const listings = await fetch(`${BASE}/api/v3/market/listings`).then((r) => r.json());
  const listingId = listings.data[0].listingId;
  const aliceSignsBefore = signsBy(IDENTITIES.alice);

  const bob = await walletPage(browser, IDENTITIES.bob);
  await bob.goto(`${BASE}/market`);
  await bob.getByRole("button", { name: /connect wallet/i }).click();
  await bob.getByRole("button", { name: "Buy", exact: true }).first().click();
  await expect(bob.getByText(/^bought — arrives when/i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);

  // The seller signed nothing at sale time.
  expect(signsBy(IDENTITIES.alice)).toBe(aliceSignsBefore);
  // Alice's wallet page has no sale to approve.
  const alice = await walletPage(browser, IDENTITIES.alice);
  await alice.goto(`${BASE}/wallet`);
  await alice.getByRole("button", { name: /connect wallet/i }).click();
  await expect(alice.getByText(/holdings/i).first()).toBeVisible();
  await expect(alice.getByRole("button", { name: /review & sign sale/i })).toHaveCount(0);

  // FILLED; Bob holds the tokens; Alice was paid exactly, at vout 1.
  const alicePf = await fetch(`${BASE}/api/v3/wallet/${IDENTITIES.alice.address}/portfolio`).then((r) => r.json());
  const filled = alicePf.data.listings.find((l: { listingId: string }) => l.listingId === listingId);
  expect(filled.status).toBe("FILLED");
  const fill = alicePf.data.fills.find((f: { listingId: string; status: string }) => f.listingId === listingId && f.status === "CONFIRMED");
  const tx = await rpc<{ vout: { value: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [fill.txid, true]);
  expect(Math.round(tx.vout[1]!.value * 1e8)).toBe(100_000);
  expect(tx.vout[1]!.scriptPubKey.hex).toBe(scriptOf(IDENTITIES.alice.privHex));
  const bobPf = await fetch(`${BASE}/api/v3/wallet/${IDENTITIES.bob.address}/portfolio`).then((r) => r.json());
  expect(bobPf.data.tokenUtxos.some((u: { tokenId: string; amountAtoms: string }) => u.tokenId === aliceTokenId && BigInt(u.amountAtoms) === 1_000n * T)).toBe(true);
  const detail = await fetch(`${BASE}/api/v3/tokens/${aliceTokenId}`).then((r) => r.json());
  expect(BigInt(detail.data.issuedSupplyAtoms)).toBe(minted - 10_000n * T);
});

test("E2E-008 cancel: Alice cancels a second listing", async ({ browser }) => {
  const { listingId } = await apiList(IDENTITIES.alice, aliceTokenId, 1_000n, 100_000);
  await mineAndWait(1);
  await waitForListing(listingId, aliceTokenId);
  const page = await walletPage(browser, IDENTITIES.alice);
  await page.goto(`${BASE}/wallet`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await expect(page.getByText(/listing cancelled/i).first()).toBeVisible({ timeout: 60_000 });
});

test("E2E-009 mint-out: the page switches to Buy / Sell / Redeem, and the market works", async ({ browser }) => {
  // Minting out takes about twenty capped mints, each confirmed in a block.
  test.setTimeout(20 * 60_000);
  // Carol launches and mints the whole curve in one go.
  const carol = await walletPage(browser, IDENTITIES.carol);
  await carol.goto(`${BASE}/launch`);
  await carol.getByLabel("Name").fill("Full Coin");
  await carol.getByLabel(/^Ticker/).fill("FULL");
  await carol.getByRole("button", { name: /review launch identity/i }).click();
  await carol.getByRole("button", { name: /connect wallet/i }).click();
  await carol.getByRole("button", { name: /build, review and sign/i }).click();
  await expect(carol.getByText(/broadcast/i).first()).toBeVisible({ timeout: 60_000 });
  await mineAndWait(1);
  const tokens = await fetch(`${BASE}/api/v3/tokens?search=FULL`).then((r) => r.json());
  const fullId = tokens.data.find((t: { ticker: string }) => t.ticker === "FULL").tokenId as string;

  // One mint is capped (COVE_REGTEST_MAX_MINT_GROSS_SATS of curve price, 0.5
  // BTC here) and the whole curve is about 0.73 BTC, so minting out takes two.
  // The page stops each one at the cap and says so.
  await carol.goto(`${BASE}/token/${fullId}`);
  await carol.getByRole("button", { name: /connect wallet/i }).click();
  for (let i = 0; i < 40; i++) {
    const d = await fetch(`${BASE}/api/v3/tokens/${fullId}`).then((r) => r.json());
    if (BigInt(d.data.issuedSupplyAtoms) >= 21_000_000n * T) break;
    await carol.getByLabel(/Spend . sats/i).fill("150000000");
    await expect(carol.getByText(/most one mint can take|last tokens on the curve/i)).toBeVisible({ timeout: 30_000 });
    await carol.getByRole("button", { name: /review mint/i }).click();
    await carol.getByRole("button", { name: /confirm . sign/i }).click();
    await expect(carol.getByText(/^minted\./i).first()).toBeVisible({ timeout: 60_000 });
    await mineAndWait(1);
  }

  // Graduated: Mint is gone; Buy, Sell and Redeem are offered.
  await carol.reload();
  await carol.getByRole("button", { name: /connect wallet/i }).click();
  await expect(carol.getByRole("button", { name: "Mint", exact: true })).toHaveCount(0);
  await carol.getByRole("button", { name: "Sell", exact: true }).click();
  await carol.getByLabel(/^Sell/).fill("1000");
  await carol.getByLabel(/For . sats/i).fill("100000");
  await carol.getByRole("button", { name: /list for sale/i }).click();
  await expect(carol.getByText(/listing created/i).first()).toBeVisible({ timeout: 60_000 });
  // A split was needed, so the listing goes live on the next block.
  await mineAndWait(1);
  const firstAsk = await fetch(`${BASE}/api/v3/market/listings?tokenId=${fullId}`).then((r) => r.json());
  expect(firstAsk.data.filter((l: { status: string }) => l.status === "ACTIVE").length).toBe(1);

  // Bob buys it from the token page; Carol signs nothing.
  const carolSignsBefore = signsBy(IDENTITIES.carol);
  const bob = await walletPage(browser, IDENTITIES.bob);
  await bob.goto(`${BASE}/token/${fullId}`);
  await bob.getByRole("button", { name: /connect wallet/i }).click();
  await bob.getByRole("button", { name: "Buy", exact: true }).first().click();
  await bob.getByRole("button", { name: "Buy", exact: true }).last().click();
  await expect(bob.getByText(/^bought — arrives when/i).first()).toBeVisible({ timeout: 60_000 });
  expect(signsBy(IDENTITIES.carol)).toBe(carolSignsBefore);
  await mineAndWait(1);
  const bobPf = await fetch(`${BASE}/api/v3/wallet/${IDENTITIES.bob.address}/portfolio`).then((r) => r.json());
  const h = bobPf.data.holdings.find((x: { tokenId: string }) => x.tokenId === fullId);
  expect(BigInt(h.amountAtoms)).toBe(1_000n * T);

  // Carol lists from her Wallet page: the form shows the floor and the vault
  // price, and the listing appears under My listings.
  await carol.goto(`${BASE}/wallet`);
  await carol.getByRole("button", { name: /connect wallet/i }).click();
  const card = carol.locator("div.border", { has: carol.locator(`a[href="/token/${fullId}"]`) }).first();
  await card.getByRole("button", { name: "List", exact: true }).click();
  await expect(card.getByText(/vault buys back at/i)).toBeVisible();
  await card.getByLabel("List amount").fill("2000");
  await card.getByLabel("Price per 1,000 tokens").fill("60000");
  await expect(card.getByText("120,000 sats")).toBeVisible();
  await card.getByRole("button", { name: "List", exact: true }).click();
  await expect(carol.getByText(/^listed 2,000 tokens for 120,000 sats/i)).toBeVisible({ timeout: 60_000 });
  // The wallet split off exactly 2,000; the listing is live once that confirms.
  await mineAndWait(1);
  for (let i = 0; i < 30; i++) {
    const l = await fetch(`${BASE}/api/v3/market/listings?tokenId=${fullId}`).then((r) => r.json());
    if (l.data.some((x: { status: string; amountAtoms: string }) => x.status === "ACTIVE" && BigInt(x.amountAtoms) === 2_000n * T)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const listings = await fetch(`${BASE}/api/v3/market/listings?tokenId=${fullId}`).then((r) => r.json());
  expect(listings.data.some((l: { status: string; amountAtoms: string; totalPriceSats: string }) =>
    l.status === "ACTIVE" && BigInt(l.amountAtoms) === 2_000n * T && l.totalPriceSats === "120000")).toBe(true);

  // The Market page has a card per launched token; clicking one shows only
  // that token's book, and the URL keeps the filter.
  await carol.goto(`${BASE}/market`);
  await expect(carol.getByRole("button", { name: "FULL market" })).toBeVisible();
  await expect(carol.getByRole("button", { name: "FROG market" })).toBeVisible();
  await carol.getByRole("button", { name: "FULL market" }).click();
  await expect(carol).toHaveURL(new RegExp(`token=${fullId}`));
  await expect(carol.getByText("Showing only $FULL.")).toBeVisible();
  await expect(carol.locator("tbody tr")).toHaveCount(1);
  await expect(carol.locator("tbody")).toContainText("0.0012 BTC");
  await carol.getByLabel("Search tokens").fill("fro");
  await expect(carol.getByRole("button", { name: "FULL market" })).toHaveCount(0);
  await expect(carol.getByRole("button", { name: "FROG market" })).toBeVisible();
});

test("E2E-010 wallet: no List before mint-out, and it says why", async ({ browser }) => {
  const page = await walletPage(browser, IDENTITIES.alice);
  await page.goto(`${BASE}/wallet`);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  const card = page.locator("div.border", { has: page.locator(`a[href="/token/${aliceTokenId}"]`) }).first();
  // Holdings name the token, not just its id.
  await expect(card.getByText("$FROG")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/listing opens when .* mints out/i)).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("button", { name: "List", exact: true })).toHaveCount(0);
});
