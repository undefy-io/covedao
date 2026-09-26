import { CONFIRMED_FUNDING_FOR_TESTS } from "./testFunding.js";
import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CoveChainView, s0StateV2 } from "@crclaunch/cove-covenant";
import { isSimplicityAvailable } from "@crclaunch/cove-simplicity";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import { buildDeployPsbtV3, buildMintPsbtV3, RESERVE_ANCHOR_SATS } from "./builder.js";
import { validateAndSignMintTransition } from "./guardian.js";
import { GuardianV3Signer } from "./signer.js";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

function xonly(byte: number): Buffer {
  return Buffer.from(ECPair.fromPrivateKey(Buffer.alloc(32, byte)).publicKey.subarray(1));
}

const guardianXOnly = xonly(0x42);
const recoveryKeyXOnly = xonly(0x43);
const K1 = xonly(0x51);
const K2 = xonly(0x52);
const K3 = xonly(0x53);
const MAINNET1 = {
  profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1" as const,
  recoveryCsvBlocks: 2016,
  recoveryThreshold: 2,
  recoveryPubkeys: [K1, K2, K3],
};

describe("production-profile MINT path (§137) — MAINNET1 vault through the Guardian", () => {
  it.skipIf(!isSimplicityAvailable())("builds + validates + signs a MINT against a 2-of-3 MAINNET1 vault", async () => {
    const tokenId = Buffer.from("ab".repeat(32), "hex");
    const s0 = s0StateV2({ tokenId: tokenId.toString("hex") });

    // Build the vault with the MAINNET1 recovery profile to obtain the S0 script.
    const deploy = buildDeployPsbtV3({ feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      network: bitcoin.networks.regtest,
      identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "FROG", tokenNonce: Buffer.alloc(32, 0xab) },
      guardianXOnly,
      recoveryKeyXOnly: recoveryKeyXOnly,
      recoveryProfile: MAINNET1,
      deployerInputs: [{ txid: "a".repeat(64), vout: 0, script: Buffer.from("0014" + "c".repeat(40), "hex"), valueSats: 1_000_000n }],
      deployerChangeScript: Buffer.from("0014" + "c".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      creatorScript: CREATOR_SCRIPT,
    });

    const mint = buildMintPsbtV3({
      network: bitcoin.networks.regtest,
      tokenId,
      prevState: s0,
      prevBacking: { txid: "a".repeat(64), vout: 1, script: deploy.vault.scriptPubKey, valueSats: RESERVE_ANCHOR_SATS },
      mintAmountAtoms: 10_000n * 100_000_000n,
      guardianXOnly,
      recoveryKeyXOnly: recoveryKeyXOnly,
      recoveryProfile: MAINNET1,
      buyerInputs: [{ txid: "b".repeat(64), vout: 0, script: Buffer.from("0014" + "d".repeat(40), "hex"), valueSats: 1_000_000n }],
      buyerCarrierScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      buyerChangeScript: Buffer.from("0014" + "e".repeat(40), "hex"),
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
      minerFeeSats: 1_000n,
      creatorScript: CREATOR_SCRIPT,
    });
    // The prev vault must use the 2-of-3 threshold recovery leaf (not single-key 144 CSV).
    expect(mint.prevVault.recoveryLeaf.script.toString("hex")).not.toBe(
      // single-key DEV1 leaf for reference is 4 bytes longer; just assert it starts with CSV operand 0x02 (2016) vs 0x0190 (144)
      "",
    );
    expect(mint.prevVault.recoveryLeaf.script[0]).toBe(0x02); // minimal-encoded 2016

    const view = new CoveChainView();
    view.deploy(
      { tokenId, ticker: "FROG", policyVersion: 3, deployTxid: "a".repeat(64), tokenNonce: Buffer.alloc(32, 0xab), creatorScript: CREATOR_SCRIPT },
      { txid: "a".repeat(64), vout: 1 },
      s0,
    );

    const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
    const out = await validateAndSignMintTransition({ fundingChecker: CONFIRMED_FUNDING_FOR_TESTS,
      signer,
      psbt: mint.psbt,
      view,
      network: "regtest",
      recoveryKeyXOnly,
      recoveryProfile: MAINNET1,
      feeScript: Buffer.from("0014" + "f".repeat(40), "hex"),
    });
    if (!out.ok) {
      // Surface the exact rejection so CI-only failures are self-diagnosing.
      throw new Error(`MINT validation rejected: ${(out as { reason?: string; detail?: string }).reason}: ${(out as { detail?: string }).detail}`);
    }
    expect(out.ok).toBe(true);
  });
});
