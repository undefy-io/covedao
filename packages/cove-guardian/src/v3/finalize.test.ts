import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  CoveChainView,
  TOKEN_CARRIER_SATS,
} from "@crclaunch/cove-covenant";
import { CHAIN_BITCOIN_REGTEST, serializeDiscovery } from "@crclaunch/cove-wire";
import { isSimplicityAvailable } from "@crclaunch/cove-simplicity";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  RESERVE_ANCHOR_SATS,
} from "./builder.js";
import { unsignedTransaction } from "./resolve.js";
import { validateFinalizedDeployTransaction, validateFinalizedMintTransaction, validateFinalizedRedeemTransaction, validateFinalizedTransferTransaction } from "./finalize.js";
import { LAUNCH_FEE_SATS } from "@crclaunch/cove-economics";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const guardianXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x42), true)!.subarray(1));
const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
const NONCE = Buffer.alloc(32, 0xab);
const feeScript = Buffer.from("0014" + "f".repeat(40), "hex");
const MINT_AMOUNT = 1_000_000n * 100_000_000n;
const DEPLOY_TXID = "aa".repeat(32);
const MINT_TXID = "ff".repeat(32);

function p2wpkh(key: ReturnType<typeof ECPair.makeRandom>): Buffer {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest }).output!;
}

/** View at the DEPLOY state (S0 backing at DEPLOY:1); NO mint recorded yet. */
function deploySetup() {
  const deploy = buildDeployPsbtV3({ feeScript,
    network: bitcoin.networks.regtest,
    identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE },
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    deployerInputs: [{ txid: "dd".repeat(32), vout: 0, script: p2wpkh(ECPair.makeRandom()), valueSats: 1_000_000n }],
    deployerChangeScript: p2wpkh(ECPair.makeRandom()),
    minerFeeSats: 1_000n,
    creatorScript: CREATOR_SCRIPT,
  });
  const view = new CoveChainView();
  view.deploy(
    { tokenId: deploy.tokenId, ticker: "FROG", policyVersion: 3, deployTxid: DEPLOY_TXID, tokenNonce: NONCE , creatorScript: CREATOR_SCRIPT},
    { txid: DEPLOY_TXID, vout: 1 },
    deploy.s0,
  );
  const alice = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const mint = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId: deploy.tokenId,
    prevState: deploy.s0,
    prevBacking: { txid: DEPLOY_TXID, vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    mintAmountAtoms: MINT_AMOUNT,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [{ txid: "ee".repeat(32), vout: 0, script: p2wpkh(alice), valueSats: 1_000_000n }],
    buyerCarrierScript: p2wpkh(alice),
    buyerChangeScript: p2wpkh(alice),
    feeScript,
    minerFeeSats: 1_000n,
    creatorScript: CREATOR_SCRIPT,
  });
  return { deploy, view, mint, alice };
}

/** View at the POST-mint state (backing at MINT_TXID:1 + Alice's token carrier). */
function mintedSetup() {
  const s = deploySetup();
  s.view.mint({
    tokenId: s.deploy.tokenId,
    nextState: s.mint.nextState,
    prevBackingOutpoint: { txid: DEPLOY_TXID, vout: 1 },
    nextBackingOutpoint: { txid: MINT_TXID, vout: 1 },
    recipientOutpoint: { txid: MINT_TXID, vout: 2 },
    recipientScript: p2wpkh(s.alice),
    amountAtoms: MINT_AMOUNT,
  });
  return s;
}

function redeemRaw(redeemAmountAtoms: bigint, minerFeeSats: bigint, discoveryEnvelope?: { ticker: string }): string {
  const s = mintedSetup();
  const bob = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const redeem = buildRedeemPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId: s.deploy.tokenId,
    prevState: s.mint.nextState,
    prevBacking: { txid: MINT_TXID, vout: 1, script: s.mint.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + s.mint.nextState.backingSats },
    redeemAmountAtoms,
    tokenInputs: [{ txid: MINT_TXID, vout: 2, script: p2wpkh(bob), valueSats: TOKEN_CARRIER_SATS }],
    tokenInputTotalAtoms: MINT_AMOUNT,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    sellerPayoutScript: p2wpkh(bob),
    sellerChangeScript: p2wpkh(bob),
    feeScript,
    minerFeeSats,
    discoveryEnvelope,
  });
  return unsignedTransaction(redeem.psbt).toHex();
}

describe("finalize — full/partial redeem BTC change layout (§3)", () => {
  const base = () => ({
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
    network: "regtest" as const,
  });

  it.skipIf(!isSimplicityAvailable())("full redeem, no BTC change (4 outputs) → valid", async () => {
    const s = mintedSetup();
    const raw = redeemRaw(MINT_AMOUNT, 1_000n);
    const r = await validateFinalizedRedeemTransaction({ rawTxHex: raw, view: s.view, ...base() });
    expect("ok" in r).toBe(false);
    if (!("ok" in r)) expect(r.operation).toBe("REDEEM");
  });

  it.skipIf(!isSimplicityAvailable())("accepts a full redeem with a matching trailing discovery output", async () => {
    const s = mintedSetup();
    const raw = redeemRaw(MINT_AMOUNT, 1_000n, { ticker: "FROG" });
    const r = await validateFinalizedRedeemTransaction({ rawTxHex: raw, view: s.view, discoveryTicker: "FROG", ...base() });
    expect("rawTxHex" in r).toBe(true);
  });

  it("rejects a redeem discovery output with the wrong ticker", async () => {
    const s = mintedSetup();
    const raw = redeemRaw(MINT_AMOUNT, 1_000n, { ticker: "DOGE" });
    const r = await validateFinalizedRedeemTransaction({ rawTxHex: raw, view: s.view, discoveryTicker: "FROG", ...base() });
    expect("rawTxHex" in r).toBe(false);
    if (!("rawTxHex" in r)) expect(r.reason).toBe("DISCOVERY_MISMATCH");
  });

  it.skipIf(!isSimplicityAvailable())("full redeem with BTC change (5 outputs) → valid", async () => {
    const s = mintedSetup();
    // miner fee 500 → seller BTC change = 1000 - 500 = 500 sats at vout 4.
    const raw = redeemRaw(MINT_AMOUNT, 500n);
    const r = await validateFinalizedRedeemTransaction({ rawTxHex: raw, view: s.view, ...base() });
    expect("ok" in r).toBe(false);
  });

  it.skipIf(!isSimplicityAvailable())("partial redeem + token change carrier (5 outputs) → valid", async () => {
    const s = mintedSetup();
    // Redeem 60M (leave 24M change): gross 37,350 → fee 374 clears P2WPKH dust.
    const raw = redeemRaw(600_000n * 100_000_000n, 0n);
    const r = await validateFinalizedRedeemTransaction({ rawTxHex: raw, view: s.view, ...base() });
    expect("ok" in r).toBe(false);
  });

  it.skipIf(!isSimplicityAvailable())("full redeem with 6 outputs → rejected (UNEXPECTED_OUTPUT)", async () => {
    const s = mintedSetup();
    const bob = ECPair.makeRandom({ network: bitcoin.networks.regtest });
    const redeem = buildRedeemPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: s.deploy.tokenId,
      prevState: s.mint.nextState,
      prevBacking: { txid: MINT_TXID, vout: 1, script: s.mint.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + s.mint.nextState.backingSats },
      redeemAmountAtoms: MINT_AMOUNT,
      tokenInputs: [{ txid: MINT_TXID, vout: 2, script: p2wpkh(bob), valueSats: TOKEN_CARRIER_SATS }],
      tokenInputTotalAtoms: MINT_AMOUNT,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      sellerPayoutScript: p2wpkh(bob),
      sellerChangeScript: p2wpkh(bob),
      feeScript,
      minerFeeSats: 500n,
    });
    const tx = unsignedTransaction(redeem.psbt);
    tx.outs.push({ script: p2wpkh(ECPair.makeRandom()), value: 1000 });
    const r = await validateFinalizedRedeemTransaction({
      rawTxHex: tx.toHex(),
      view: s.view,
      ...base(),
    });
    expect("ok" in r).toBe(true);
    if ("ok" in r) expect(r.reason).toMatch(/UNEXPECTED_OUTPUT/);
  });
});

describe("finalize — branded ValidatedCoveTransaction", () => {
  it.skipIf(!isSimplicityAvailable())("valid MINT finalize returns a branded object", async () => {
    const s = deploySetup();
    const raw = unsignedTransaction(s.mint.psbt).toHex();
    const r = await validateFinalizedMintTransaction({
      rawTxHex: raw,
      view: s.view,
      network: "regtest",
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      feeScript,
    });
    expect("ok" in r).toBe(false);
    if (!("ok" in r)) {
      expect(r.operation).toBe("MINT");
      expect(r.tokenId).toHaveLength(64);
      expect(r.validationDigest).toHaveLength(64);
    }
  });
});

describe("finalize — DEPLOY launch fee (output 3)", () => {
  const base = {
    network: "regtest" as const,
    chainIdentity: CHAIN_BITCOIN_REGTEST,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
  };
  function deployTx(discoveryEnvelope?: { ticker: string }): bitcoin.Transaction {
    const d = buildDeployPsbtV3({
      feeScript,
      network: bitcoin.networks.regtest,
      identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: NONCE },
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      deployerInputs: [{ txid: "dd".repeat(32), vout: 0, script: CREATOR_SCRIPT, valueSats: 1_000_000n }],
      deployerChangeScript: CREATOR_SCRIPT,
      minerFeeSats: 1_000n,
      creatorScript: CREATOR_SCRIPT,
      discoveryEnvelope,
    });
    return unsignedTransaction(d.psbt);
  }

  it("the builder pays exactly LAUNCH_FEE_SATS to the fee address, and finalize accepts it", () => {
    const tx = deployTx();
    expect(tx.outs[3]!.value).toBe(Number(LAUNCH_FEE_SATS));
    expect(tx.outs[3]!.script.equals(feeScript)).toBe(true);
    const r = validateFinalizedDeployTransaction({ ...base, rawTxHex: tx.toHex() });
    expect("rawTxHex" in r).toBe(true);
  });

  it("accepts a matching DEPLOY discovery output and rejects a changed ticker", () => {
    const tx = deployTx({ ticker: "FROG" });
    const valid = validateFinalizedDeployTransaction({ ...base, rawTxHex: tx.toHex() });
    expect("rawTxHex" in valid).toBe(true);
    const wrong = serializeDiscovery({ p: "crc-20", op: "deploy", tick: "DOGE" });
    tx.outs[tx.outs.length - 1]!.script = Buffer.concat([Buffer.from([0x6a, wrong.length]), wrong]);
    const invalid = validateFinalizedDeployTransaction({ ...base, rawTxHex: tx.toHex() });
    expect("rawTxHex" in invalid).toBe(false);
    if (!("rawTxHex" in invalid)) expect(invalid.reason).toBe("DISCOVERY_MISMATCH");
  });

  it("refuses a DEPLOY with no fee, the wrong amount, or another address", () => {
    const mutations: [string, (tx: bitcoin.Transaction) => void][] = [
      ["no fee", (tx) => { tx.outs.splice(3); }],
      ["short", (tx) => { tx.outs[3]!.value = Number(LAUNCH_FEE_SATS) - 1; }],
      ["over", (tx) => { tx.outs[3]!.value = Number(LAUNCH_FEE_SATS) + 1; }],
      ["other address", (tx) => { tx.outs[3]!.script = Buffer.from("0014" + "e".repeat(40), "hex"); }],
    ];
    for (const [label, mutate] of mutations) {
      const tx = deployTx();
      mutate(tx);
      const r = validateFinalizedDeployTransaction({ ...base, rawTxHex: tx.toHex() });
      expect({ label, ok: "rawTxHex" in r }).toEqual({ label, ok: false });
      if (!("rawTxHex" in r)) expect(r.reason).toBe("LAUNCH_FEE_MISSING");
    }
  });
});

describe("finalize — TRANSFER discovery output", () => {
  it("accepts a matching marker and rejects a different ticker", () => {
    const s = mintedSetup();
    const carrier = p2wpkh(s.alice);
    const transfer = buildTransferPsbtV2({
      network: bitcoin.networks.regtest,
      tokenId: s.deploy.tokenId,
      tokenInputs: [{ txid: MINT_TXID, vout: 2, script: carrier, valueSats: TOKEN_CARRIER_SATS }],
      tokenInputTotalAtoms: MINT_AMOUNT,
      tokenOutputs: [{ script: carrier, amountAtoms: MINT_AMOUNT }],
      funderInputs: [{ txid: "bb".repeat(32), vout: 0, script: carrier, valueSats: 100_000n }],
      funderChangeScript: carrier,
      btcOutputs: [],
      minerFeeSats: 1_000n,
      discoveryEnvelope: { ticker: "FROG" },
    });
    const tx = unsignedTransaction(transfer.psbt);
    const valid = validateFinalizedTransferTransaction({ rawTxHex: tx.toHex(), view: s.view, discoveryTicker: "FROG" });
    expect("rawTxHex" in valid).toBe(true);
    const wrong = serializeDiscovery({ p: "crc-20", op: "transfer", tick: "DOGE", amt: MINT_AMOUNT.toString() });
    tx.outs[tx.outs.length - 1]!.script = Buffer.concat([Buffer.from([0x6a, wrong.length]), wrong]);
    const invalid = validateFinalizedTransferTransaction({ rawTxHex: tx.toHex(), view: s.view, discoveryTicker: "FROG" });
    expect("rawTxHex" in invalid).toBe(false);
    if (!("rawTxHex" in invalid)) expect(invalid.reason).toBe("DISCOVERY_MISMATCH");
  });
});
