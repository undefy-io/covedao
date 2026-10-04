import * as ecc from "tiny-secp256k1";
import { concat, hex, sized, unhex, utf8 } from "./bytes.js";
import { taggedHash, validateGuardianCustody } from "./taproot.js";
import { capAtoms, carrierSats } from "./economics.js";
import { sats } from "./wire.js";
import { requireSupportedOutputScript } from "./target.js";
import type { Config, EscrowTerms, Input, Offer } from "./types.js";

const nums = unhex("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
const fields = [
  "version",
  "network",
  "deployTxid",
  "ticker",
  "amountAtoms",
  "priceSats",
  "sellerTokenScriptHex",
  "sellerPayoutScriptHex",
  "sellerAuthorityScriptHex",
  "protocolScriptHex",
  "feePolicy",
  "expiryHeight",
  "guardianPublicKeyHex",
  "nonceHex",
];
export function validateEscrowTerms(t: EscrowTerms): void {
  if (
    Object.keys(t).length !== fields.length ||
    Object.keys(t).some((k) => !fields.includes(k)) ||
    t.version !== 1 ||
    !["regtest", "signet", "testnet", "bitcoin"].includes(t.network) ||
    !/^[0-9a-f]{64}$/.test(t.deployTxid) ||
    !/^[A-Za-z0-9]{1,16}$/.test(t.ticker) ||
    typeof t.amountAtoms !== "bigint" ||
    t.amountAtoms <= 0n ||
    t.amountAtoms > capAtoms ||
    typeof t.priceSats !== "bigint" ||
    t.priceSats <= 0n ||
    !Number.isSafeInteger(t.expiryHeight) ||
    t.expiryHeight < 1 ||
    t.expiryHeight > 0xffffffff ||
    t.feePolicy !== "market-v1" ||
    !/^[0-9a-f]{64}$/.test(t.nonceHex) ||
    !/^[0-9a-f]{64}$/.test(t.guardianPublicKeyHex) ||
    !ecc.isXOnlyPoint(unhex(t.guardianPublicKeyHex))
  )
    throw new Error("invalid escrow terms");
  sats(t.priceSats + carrierSats);
  for (const script of [
    t.sellerTokenScriptHex,
    t.sellerPayoutScriptHex,
    t.sellerAuthorityScriptHex,
    t.protocolScriptHex,
  ]) {
    if (typeof script !== "string" || script.length > 70 || !/^[0-9a-f]+$/.test(script))
      throw new Error("invalid escrow script");
    requireSupportedOutputScript(script);
  }
}
/** Explicit ordered, versioned encoding; object insertion order never changes the commitment. */
export function escrowTermsMessage(t: EscrowTerms): string {
  validateEscrowTerms(t);
  return JSON.stringify([
    "cove-crc-escrow-v1",
    ...fields.map((field) => {
      const value = t[field as keyof EscrowTerms];
      return typeof value === "bigint" ? value.toString() : value;
    }),
  ]);
}
export function escrowCustody(t: EscrowTerms) {
  const commitmentHex = hex(taggedHash("CoveCRCEscrow", utf8(escrowTermsMessage(t))));
  const execution = concat(
    Uint8Array.of(32),
    unhex(commitmentHex),
    Uint8Array.of(0x88, 32),
    unhex(t.guardianPublicKeyHex),
    Uint8Array.of(0xac),
  );
  const leafHash = taggedHash("TapLeaf", concat(Uint8Array.of(0xc0), sized(execution)));
  const output = ecc.xOnlyPointAddTweak(nums, taggedHash("TapTweak", concat(nums, leafHash)));
  if (!output) throw new Error("invalid escrow Taproot tweak");
  return {
    commitmentHex,
    executionScriptHex: hex(execution),
    controlBlockHex: hex(concat(Uint8Array.of(0xc0 | output.parity), nums)),
    leafHashHex: hex(leafHash),
    scriptHex: `5120${hex(output.xOnlyPubkey)}`,
  };
}
export function validateEscrowConfig(t: EscrowTerms, c: Config): void {
  if (!c.guardianCustody) throw new Error("registered Guardian escrow required");
  validateGuardianCustody(c.vaultScriptHex, c.guardianCustody);
  validateEscrowTerms(t);
  if (
    !c.guardianCustody ||
    t.network !== c.network ||
    t.ticker !== c.ticker ||
    t.protocolScriptHex !== c.protocolScriptHex ||
    t.guardianPublicKeyHex !== c.guardianCustody.guardianPublicKeyHex
  )
    throw new Error("escrow registered authority mismatch");
}
export function escrowOffer(terms: EscrowTerms, input: Input): Offer {
  const escrow = escrowCustody(terms);
  if (
    input.scriptHex !== escrow.scriptHex ||
    sats(input.sats) !== carrierSats ||
    (input.atoms !== undefined && input.atoms !== terms.amountAtoms)
  )
    throw new Error("escrow listing output mismatch");
  return {
    network: terms.network,
    deployTxid: terms.deployTxid,
    ticker: terms.ticker,
    listedInput: {
      txid: input.txid,
      vout: input.vout,
      sats: carrierSats,
      atoms: terms.amountAtoms,
      deployTxid: terms.deployTxid,
      scriptHex: escrow.scriptHex,
    },
    sellerScriptHex: terms.sellerPayoutScriptHex,
    priceSats: terms.priceSats,
    expiryHeight: terms.expiryHeight,
    publicKeyHex: terms.guardianPublicKeyHex,
    signatureHex: "",
    sellerWitnessHex: [],
    escrowTerms: structuredClone(terms),
  };
}
