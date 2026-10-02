import { expect, type Page } from "@playwright/test";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { ECPairFactory } from "ecpair";
import { readFileSync } from "node:fs";
import * as ecc from "tiny-secp256k1";
import { authorizeOffer } from "../../../packages/cove-market/crc20-protocol/test-support/signing.js";
export const key = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 2));
export const script = bitcoin.payments.p2wpkh({ pubkey: key.publicKey }).output!.toString("hex");
export const deployTxid = "aa".repeat(32), assetId = `regtest:${deployTxid}`;
const custody = JSON.parse(readFileSync(new URL("../../../artifacts/crc-core-integration/wallet-capabilities/xverse-core-mint-request.json", import.meta.url), "utf8")).state.config;
export const config = { network: "regtest", ticker: "TEST", vaultScriptHex: custody.vaultScriptHex, guardianCustody: custody.guardianCustody, creatorScriptHex: script, protocolScriptHex: `0014${"22".repeat(20)}` };
export const state: core.Asset = { config, deployTxid, issuedAtoms: 1000n * core.atomsPerToken, inventoryAtoms: 0n, burnedAtoms: 0n,
  vault: { txid: "bb".repeat(32), vout: 0, sats: 1027n, scriptHex: config.vaultScriptHex } };
export const token = { assetId, network: "regtest", deployTxid, ticker: "TEST", deployHeight: "100", protocolVersion: 3,
  availability: "active", mintedAtoms: state.issuedAtoms.toString(), circulatingAtoms: state.issuedAtoms.toString(), inventoryAtoms: "0", burnedAtoms: "0",
  vault: { txid: state.vault.txid, vout: 0, btcSats: "1027", scriptHex: config.vaultScriptHex }, creatorScriptHex: script, protocolScriptHex: config.protocolScriptHex,
  metadata: { displayName: "Test Token", description: "A deterministic token for interface verification.", websiteUrl: null, xUrl: null, imageUrl: null }, coreState: core.encodeProtocolDto(state) };
export const tokenCoin = { txid: "dd".repeat(32), vout: 0, sats: 1000n, atoms: state.issuedAtoms, scriptHex: script, deployTxid };
export const funding = { txid: "ee".repeat(32), vout: 0, sats: 20000n, scriptHex: script };
export const indexedTip = { height: "120", blockHash: "cc".repeat(32) };
export async function fixture(page: Page) {
  const offer = await authorizeOffer({ network: "regtest", deployTxid, ticker: "TEST", listedInput: { txid: "dd".repeat(32), vout: 0, sats: 1000n, atoms: state.issuedAtoms, scriptHex: script, deployTxid }, sellerScriptHex: script, priceSats: 5000n, expiryHeight: 140 }, key.privateKey!);
  const listing = { id: core.offerId(offer), network: "regtest", deployTxid, ticker: "TEST", sellerScriptHex: script, sellerPayoutScriptHex: script,
    sellerAnchorTxid: offer.listedInput.txid, sellerAnchorVout: 0, sellerAnchorSats: 1000, amountAtoms: state.issuedAtoms.toString(), priceSats: 5000,
    protocolFeeSats: 1000, expiresAtHeight: "140", status: "OPEN", coreOffer: core.encodeProtocolDto(offer) };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()); let data: unknown;
    if (url.pathname.endsWith("/envelope/")) { await route.fulfill({ status: 200, body: "" }); return; }
    if (url.pathname.endsWith("/trading/status")) data = { tradingActive: true, network: "regtest", protocolScriptHex: config.protocolScriptHex };
    else if (url.pathname.endsWith("/market/status")) data = { active: true };
    else if (url.pathname.endsWith("/market/listings")) data = { active: true, listings: [listing] };
    else if (url.pathname.endsWith("/fees")) data = { maxMinerFeeSats: "20000", floorSatPerVb: "1", ceilingSatPerVb: "500", estimated: false, tiers: [ { key: "eco", label: "Eco", blocks: 6, satPerVb: "1" }, { key: "standard", label: "Standard", blocks: 3, satPerVb: "2" }, { key: "priority", label: "Priority", blocks: 1, satPerVb: "3" } ], typicalVsize: { DEPLOY: 220, BACKING_BUY: 300, REDEEM: 320, TRANSFER: 220 } };
    else if (url.pathname.endsWith("/quote")) {
      const atoms = BigInt(route.request().postDataJSON().amountAtoms);
      if (url.pathname.includes("/sell/")) {
        const q = core.quoteSell(state, atoms);
        data = { quote: { assetId, amountAtoms: atoms.toString(), vaultOutpoint: core.outpoint(state.vault), grossSats: q.grossSats.toString(), protocolFeeSats: q.protocolFeeSats.toString(), sellerPayoutSats: q.sellerPayoutSats.toString(), walletTopUpSats: q.walletTopUpSats.toString(), sellerNetSats: q.economicSats.toString() } };
        await route.fulfill({ json: { ok: true, data } }); return;
      }
      const q = core.quoteBuy(state, atoms);
      data = { quote: { assetId, amountAtoms: atoms.toString(), vaultOutpoint: core.outpoint(state.vault), grossSats: q.grossSats.toString(), protocolFeeSats: q.protocolFeeSats.toString(), creatorFeeSats: q.creatorFeeSats.toString(), buyerTotalSats: (q.grossSats + q.protocolFeeSats + q.creatorFeeSats).toString() } };
    } else if (url.pathname.endsWith("/activity")) data = { rows: [], network: "regtest" };
    else if (url.pathname.endsWith("/candles")) data = { candles: [], tradeCount: 0 };
    else if (url.pathname.endsWith("/balances")) data = { balances: [{ assetId, ticker: "TEST", atoms: "100000000000" }], nextCursor: null };
    else if (url.pathname.endsWith("/wallet/utxos")) data = { utxos: [{ txid: funding.txid, vout: 0, valueSats: "20000", confirmations: 1 }, { txid: tokenCoin.txid, vout: 0, valueSats: "1000", confirmations: 1 }] };
    else if (url.pathname.endsWith("/utxos")) data = { utxos: [{ txid: tokenCoin.txid, vout: 0, atoms: tokenCoin.atoms.toString(), btcSats: "1000", scriptHex: script }], truncated: false };
    else if (url.pathname.endsWith("/market/funding-check")) data = { tokenFreeOutpoints: [{ txid: funding.txid, vout: 0 }] };
    else if (url.pathname.endsWith("/tokens")) data = { indexedTip, tokens: [token], nextCursor: null };
    else if (url.pathname.includes("/tokens/")) data = { indexedTip, token };
    else throw new Error(`Unexpected fixture API ${url.pathname}`);
    await route.fulfill({ json: { ok: true, data } });
  });
}
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal { display:none !important }" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText(/Loading listings|Reading confirmed activity|Calculating|Reading indexed/)).toHaveCount(0);
}

