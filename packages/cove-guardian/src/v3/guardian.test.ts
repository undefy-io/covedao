import { CONFIRMED_FUNDING_FOR_TESTS } from "./testFunding.js";
import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  CoveChainView,
  TOKEN_CARRIER_SATS,
} from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { CHAIN_BITCOIN_REGTEST, encodeMintV2 } from "@crclaunch/cove-wire";
import { isSimplicityAvailable } from "@crclaunch/cove-simplicity";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  RESERVE_ANCHOR_SATS,
} from "./builder.js";
import { GuardianV3Signer } from "./signer.js";
import { validateAndSignMintTransition, validateAndSignRedeemTransition } from "./guardian.js";
import { LocalGuardianTransitionSigner, type GuardianRiskPolicy } from "./transitionSigner.js";
import { unsignedTxDigest } from "./resolve.js";
import { InMemorySigningJournal } from "./journal.js";
import type { AuditRecord } from "./types.js";
import type { FundingInputChecker } from "./funding.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
const guardianXOnly = signer.xOnlyPubkey();
const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
const NONCE = Buffer.alloc(32, 0xab);
const feeScript = Buffer.from("0014" + "f".repeat(40), "hex"); // valid P2WPKH
const MINT_AMOUNT = 1_000_000n * 100_000_000n;

type K = ReturnType<typeof ECPair.makeRandom>;
function p2wpkh(key: K): Buffer {
  return bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest })
    .output!;
}
function opReturn(wire: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x6a, wire.length]), wire]);
}
function input0HasSignature(psbt: bitcoin.Psbt): boolean {
  return psbt.data.inputs[0]!.finalScriptWitness !== undefined;
}

// bitcoinjs exposes no public "set output value/script" API, so mutation tests
// rewrite the cached unsigned-tx outputs directly (test-only).
function setOutputValue(psbt: bitcoin.Psbt, vout: number, value: number): void {
  (psbt as any).__CACHE.__TX.outs[vout].value = value;
}
function setOutputScript(psbt: bitcoin.Psbt, vout: number, script: Buffer): void {
  (psbt as any).__CACHE.__TX.outs[vout].script = script;
}
function setInputValue(psbt: bitcoin.Psbt, index: number, value: number): void {
  psbt.data.inputs[index]!.witnessUtxo!.value = value;
}

const DEPLOY_TXID = "aa".repeat(32);

function mintSetup(overrides: Partial<Parameters<typeof buildMintPsbtV3>[0]> = {}) {
  const deploy = buildDeployPsbtV3({ feeScript,
    network: bitcoin.networks.regtest,
    identity: {
      chainIdentity: CHAIN_BITCOIN_REGTEST,
      policyVersion: 3,
      ticker: "FROG",
      tokenNonce: NONCE,
    },
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
    prevBacking: {
      txid: DEPLOY_TXID,
      vout: 1,
      script: deploy.vault.scriptPubKey,
      valueSats: RESERVE_ANCHOR_SATS,
    },
    mintAmountAtoms: MINT_AMOUNT,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [{ txid: "ee".repeat(32), vout: 0, script: p2wpkh(alice), valueSats: 1_000_000n }],
    buyerCarrierScript: p2wpkh(alice),
    buyerChangeScript: p2wpkh(alice),
    feeScript,
    minerFeeSats: 1_000n,
    ...overrides,
    creatorScript: CREATOR_SCRIPT,
  });
  return { deploy, view, mint, alice };
}

function signMint(psbt: bitcoin.Psbt, view: CoveChainView, fundingChecker: FundingInputChecker = CONFIRMED_FUNDING_FOR_TESTS) {
  return validateAndSignMintTransition({ fundingChecker,
    signer,
    psbt,
    view,
    network: "regtest",
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
  });
}

describe("Production Guardian V3 — validateAndSignMintTransition", async () => {
  it("unconfirmed funding input → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    const seen: string[] = [];
    const unconfirmed: FundingInputChecker = {
      async check(o) {
        seen.push(`${o.txid}:${o.vout}`);
        return { ok: false, code: "FUNDING_UNCONFIRMED", detail: "in the mempool" };
      },
    };
    const r = await signMint(mint.psbt, view, unconfirmed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FUNDING_UNCONFIRMED");
    expect(seen).toEqual([`${"ee".repeat(32)}:0`]); // the buyer's input, never the vault
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("funding input that is a carrier of this token → refused without asking the chain", async () => {
    const { view, mint, deploy, alice } = mintSetup();
    view.tokenUtxos.set(`${"ee".repeat(32)}:0`, {
      outpoint: { txid: "ee".repeat(32), vout: 0 },
      tokenId: deploy.tokenId,
      amountAtoms: MINT_AMOUNT,
      scriptPubKey: p2wpkh(alice),
    });
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FUNDING_HOLDS_TOKEN");
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("funding input holding another token or an inscription → refused", async () => {
    const { view, mint } = mintSetup();
    const inscribed: FundingInputChecker = {
      async check() {
        return { ok: false, code: "FUNDING_HOLDS_TOKEN", detail: "holds 1 inscription(s)" };
      },
    };
    const r = await signMint(mint.psbt, view, inscribed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("FUNDING_HOLDS_TOKEN");
  });

  it.skipIf(!isSimplicityAvailable())("valid MINT: Simplicity PASS + reference PASS + signs", async () => {
    const { view, mint } = mintSetup();
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedCmr).toBe(r.actualCmr);
      expect(r.simplicityResult).toBe("PASS");
      expect(r.referencePolicyResult).toBe("PASS");
      expect(input0HasSignature(mint.psbt)).toBe(true);
    }
  });

  it.skipIf(!isSimplicityAvailable())("accepts a finalized wallet funding input before Guardian signing", async () => {
    const { view, mint, alice } = mintSetup();
    mint.psbt.signInput(1, alice);
    mint.psbt.finalizeInput(1);
    const result = await signMint(mint.psbt, view);
    expect(result.ok).toBe(true);
  });

  it("wrong backing outpoint → refused, zero signatures", async () => {
    const { view, deploy } = mintSetup();
    const bad = mintSetup({
      prevBacking: { txid: "bb".repeat(32), vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
    });
    const r = await signMint(bad.mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(bad.mint.psbt)).toBe(false);
  });

  it("wrong backing value → refused, zero signatures", async () => {
    const { view, deploy } = mintSetup();
    const bad = mintSetup({
      prevBacking: { txid: DEPLOY_TXID, vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + 1n },
    });
    const r = await signMint(bad.mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(bad.mint.psbt)).toBe(false);
  });

  it("mutated amount (wire) → refused, zero signatures", async () => {
    const { view, mint, deploy } = mintSetup();
    const wire = encodeMintV2({ tokenId: deploy.tokenId, amount: MINT_AMOUNT + 100_000_000n, recipientVout: 2 });
    setOutputScript(mint.psbt, 0, opReturn(wire));
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("successor backing +1 sat → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    setOutputValue(mint.psbt, 1, Number(RESERVE_ANCHOR_SATS + 47_950n + 1n));
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("protocol fee +1 sat → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    setOutputValue(mint.psbt, 3, 495);
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("fee destination mutated → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    setOutputScript(mint.psbt, 3, Buffer.from("0014" + "e".repeat(40), "hex"));
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("carrier value +1 sat → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    setOutputValue(mint.psbt, 2, Number(TOKEN_CARRIER_SATS + 1n));
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("wrong tap leaf (REDEEM leaf) → refused, zero signatures", async () => {
    const { view, mint, deploy } = mintSetup();
    const prevVault = buildBackingVaultV3({
      state: deploy.s0,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      network: bitcoin.networks.regtest,
    });
    // Directly swap the execution leaf (test-only mutation of the PSBT data).
    const leaf = mint.psbt.data.inputs[0]!.tapLeafScript![0]!;
    leaf.script = prevVault.redeemLeaf.script;
    leaf.controlBlock = prevVault.redeemControlBlock;
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("excessive miner fee → refused, zero signatures", async () => {
    const { view } = mintSetup();
    const bad = mintSetup({ minerFeeSats: 25_000n });
    const r = await signMint(bad.mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(bad.mint.psbt)).toBe(false);
  });

  it("negative miner fee (outputs exceed inputs) → refused, zero signatures (§C13)", async () => {
    const { view, mint } = mintSetup();
    setInputValue(mint.psbt, 1, 0); // buyer contributes nothing → totalIn < totalOut
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("NEGATIVE_MINER_FEE");
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it.skipIf(!isSimplicityAvailable())("releases the journal reservation when signing throws (§C6)", async () => {
    const { view, mint } = mintSetup();
    const journal = new InMemorySigningJournal();
    const backend = {
      xOnlyPubkey: async () => guardianXOnly,
      signVaultExecutionLeaf: async () => { throw new Error("no witnessUtxo"); },
    };
    const policy: GuardianRiskPolicy = { maxGrossSats: 1_000_000n, maxMintAtoms: 1_000_000_000n * 100_000_000n, minMintGrossSats: 0n, maxRedeemPayoutSats: 1_000_000n, maxBackingSats: 100_000_000n, maxMinerFeeSats: 20_000n, allowedTokenIds: [], enforceTokenAllowlist: false };
    const audit = {
      async writeBeforeSign(_r: AuditRecord) { return { auditHash: "0".repeat(64) }; },
      async writeAfterSign() {},
    };
    const local = new LocalGuardianTransitionSigner(backend, journal, audit, policy);
    const out = await local.signMint({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS, psbt: mint.psbt, view, network: "regtest", recoveryKeyXOnly: recoveryXOnly, feeScript });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("SIGNING_FAILED");
    // Reservation released → the backing outpoint is not bricked.
    expect(await journal.committedDigest("regtest", DEPLOY_TXID, 1, unsignedTxDigest(mint.psbt))).toBeNull();
  });

  it("extra output → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    mint.psbt.addOutput({ script: p2wpkh(ECPair.makeRandom()), value: 1_000 });
    const r = await signMint(mint.psbt, view);
    expect(r.ok).toBe(false);
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });

  it("mainnet without the MAINNET1 recovery profile → refused, zero signatures", async () => {
    const { view, mint } = mintSetup();
    const r = await validateAndSignMintTransition({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
      signer,
      psbt: mint.psbt,
      view,
      network: "mainnet" as never,
      recoveryKeyXOnly: recoveryXOnly,
      feeScript,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MAINNET_PROFILE_REQUIRED");
    expect(input0HasSignature(mint.psbt)).toBe(false);
  });
});

describe("Production Guardian V3 — validateAndSignRedeemTransition", async () => {
  function redeemSetup(): { view: CoveChainView; redeem: ReturnType<typeof buildRedeemPsbtV3>; tokenId: Buffer } {
    const { view, mint, deploy } = mintSetup();
    const mintTxid = "ff".repeat(32);
    // Advance the view to post-mint state and give Bob the token carrier.
    view.mint({
      tokenId: deploy.tokenId,
      nextState: mint.nextState,
      prevBackingOutpoint: { txid: DEPLOY_TXID, vout: 1 },
      nextBackingOutpoint: { txid: mintTxid, vout: 1 },
      recipientOutpoint: { txid: mintTxid, vout: 2 },
      recipientScript: p2wpkh(ECPair.makeRandom()),
      amountAtoms: MINT_AMOUNT,
    });
    const bob = ECPair.makeRandom({ network: bitcoin.networks.regtest });
    const redeem = buildRedeemPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: deploy.tokenId,
      prevState: mint.nextState,
      prevBacking: {
        txid: mintTxid,
        vout: 1,
        script: mint.nextVault.scriptPubKey,
        valueSats: RESERVE_ANCHOR_SATS + mint.nextState.backingSats,
      },
      redeemAmountAtoms: MINT_AMOUNT,
      tokenInputs: [{ txid: mintTxid, vout: 2, script: p2wpkh(bob), valueSats: TOKEN_CARRIER_SATS }],
      tokenInputTotalAtoms: MINT_AMOUNT,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      sellerPayoutScript: p2wpkh(bob),
      sellerChangeScript: p2wpkh(bob),
      feeScript,
      minerFeeSats: 1_000n,
    });
    return { view, redeem, tokenId: deploy.tokenId };
  }

  it.skipIf(!isSimplicityAvailable())("valid REDEEM: Simplicity PASS + reference PASS + signs", async () => {
    const { view, redeem } = redeemSetup();
    const r = await validateAndSignRedeemTransition({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
      signer,
      psbt: redeem.psbt,
      view,
      network: "regtest",
      recoveryKeyXOnly: recoveryXOnly,
      feeScript,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedCmr).toBe(r.actualCmr);
      expect(r.simplicityResult).toBe("PASS");
      expect(input0HasSignature(redeem.psbt)).toBe(true);
    }
  });

  it("seller payout +1 sat → refused, zero signatures", async () => {
    const { view, redeem } = redeemSetup();
    setOutputValue(redeem.psbt, 2, Number(47_470n + 1n));
    const r = await validateAndSignRedeemTransition({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
      signer,
      psbt: redeem.psbt,
      view,
      network: "regtest",
      recoveryKeyXOnly: recoveryXOnly,
      feeScript,
    });
    expect(r.ok).toBe(false);
    expect(input0HasSignature(redeem.psbt)).toBe(false);
  });

  it("forged token input (wrong outpoint) → refused, zero signatures", async () => {
    const { view, mint, deploy } = mintSetup();
    const mintTxid = "ff".repeat(32);
    view.mint({
      tokenId: deploy.tokenId,
      nextState: mint.nextState,
      prevBackingOutpoint: { txid: DEPLOY_TXID, vout: 1 },
      nextBackingOutpoint: { txid: mintTxid, vout: 1 },
      recipientOutpoint: { txid: mintTxid, vout: 2 },
      recipientScript: p2wpkh(ECPair.makeRandom()),
      amountAtoms: MINT_AMOUNT,
    });
    // Token input spends an outpoint that is NOT a canonical token UTXO.
    const forged = buildRedeemPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId: deploy.tokenId,
      prevState: mint.nextState,
      prevBacking: { txid: mintTxid, vout: 1, script: mint.nextVault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS + mint.nextState.backingSats },
      redeemAmountAtoms: MINT_AMOUNT,
      tokenInputs: [{ txid: "12".repeat(32), vout: 0, script: p2wpkh(ECPair.makeRandom()), valueSats: TOKEN_CARRIER_SATS }],
      tokenInputTotalAtoms: MINT_AMOUNT,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      sellerPayoutScript: p2wpkh(ECPair.makeRandom()),
      sellerChangeScript: p2wpkh(ECPair.makeRandom()),
      feeScript,
      minerFeeSats: 1_000n,
    });
    const r = await validateAndSignRedeemTransition({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
      signer,
      psbt: forged.psbt,
      view,
      network: "regtest",
      recoveryKeyXOnly: recoveryXOnly,
      feeScript,
    });
    expect(r.ok).toBe(false);
    expect(input0HasSignature(forged.psbt)).toBe(false);
  });
});
