import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { encodeMintV2, encodeRedeemV2 } from "@crclaunch/cove-wire/codec-v2";
import { verifyClientIntent, unsignedTxDigestHex, type ClientIntent } from "./cove-intent.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

function scriptFor(byte: number): Buffer {
  const k = ECPair.fromPrivateKey(Buffer.alloc(32, byte));
  return bitcoin.payments.p2wpkh({ pubkey: k.publicKey, network: bitcoin.networks.regtest })
    .output!;
}

const walletScript = scriptFor(0x49);
const attackerScript = scriptFor(0x59);
const feeScript = scriptFor(0x69);
const vaultScript = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0x11)]);

const TOKEN_ID = Buffer.alloc(32, 0xab);
const TOKEN_ID_HEX = TOKEN_ID.toString("hex");
const AMOUNT_ATOMS = 4_200_000_000_000_000n;

function opReturn(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x6a, payload.length]), payload]);
}

// ── a realistic REDEEM ──────────────────────────────────────────────────────
// vault in 110,000 (10,000 anchor + 100,000 backing) + one 1,000-sat carrier.
// gross 21,000, protocol fee 210, payout 20,790, miner fee 1,000.
const REDEEM = {
  grossSats: 21_000n,
  protocolFeeSats: 210n,
  netSats: 20_790n,
  minerFeeSats: 1_000n,
};

function buildRedeemPsbt(
  opts: { payoutScript?: Buffer; envelopeAmount?: bigint; omitEnvelope?: boolean } = {},
): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({
    hash: "22".repeat(32),
    index: 0,
    witnessUtxo: { script: vaultScript, value: 110_000 },
  });
  psbt.addInput({
    hash: "33".repeat(32),
    index: 0,
    witnessUtxo: { script: walletScript, value: 1_000 },
  });
  if (!opts.omitEnvelope) {
    const wire = encodeRedeemV2({
      tokenId: TOKEN_ID,
      redeemAmount: opts.envelopeAmount ?? AMOUNT_ATOMS,
      changeAllocations: [],
    });
    psbt.addOutput({ script: opReturn(wire), value: 0 });
  }
  psbt.addOutput({ script: vaultScript, value: 89_000 });
  psbt.addOutput({ script: opts.payoutScript ?? walletScript, value: Number(REDEEM.netSats) });
  psbt.addOutput({ script: feeScript, value: Number(REDEEM.protocolFeeSats) });
  return psbt;
}

function redeemIntent(psbt: bitcoin.Psbt, overrides: Partial<ClientIntent> = {}): ClientIntent {
  const totalIn = psbt.data.inputs.reduce((s, i) => s + BigInt(i.witnessUtxo?.value ?? 0), 0n);
  const totalOut = psbt.txOutputs.reduce((s, o) => s + BigInt(o.value), 0n);
  return {
    operation: "REDEEM",
    tokenId: TOKEN_ID_HEX,
    tokenAmountAtoms: AMOUNT_ATOMS.toString(),
    grossSats: REDEEM.grossSats.toString(),
    protocolFeeSats: REDEEM.protocolFeeSats.toString(),
    minerFeeSats: (totalIn - totalOut).toString(),
    netSats: REDEEM.netSats.toString(),
    walletScript: walletScript.toString("hex"),
    stateHash: "cd".repeat(32),
    unsignedTxDigest: unsignedTxDigestHex(psbt),
    ...overrides,
  };
}

// ── a realistic BACKING_BUY ─────────────────────────────────────────────────
// buyer pays 30,000 price + 2,300 protocol fee + 1,000 miner fee, and gets a
// 1,000-sat carrier back. Funding input 40,000, change 5,700.
const BUY = { grossSats: 30_000n, protocolFeeSats: 2_300n, minerFeeSats: 1_000n };

function buildMintPsbt(
  opts: {
    carrierScript?: Buffer;
    envelopeAmount?: bigint;
    recipientVout?: number;
    vaultOutSats?: number;
    changeSats?: number;
  } = {},
): bitcoin.Psbt {
  const wire = encodeMintV2({
    tokenId: TOKEN_ID,
    amount: opts.envelopeAmount ?? AMOUNT_ATOMS,
    recipientVout: opts.recipientVout ?? 2,
  });
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({
    hash: "44".repeat(32),
    index: 0,
    witnessUtxo: { script: vaultScript, value: 10_000 },
  });
  psbt.addInput({
    hash: "55".repeat(32),
    index: 0,
    witnessUtxo: { script: walletScript, value: 40_000 },
  });
  psbt.addOutput({ script: opReturn(wire), value: 0 }); // 0
  psbt.addOutput({ script: vaultScript, value: opts.vaultOutSats ?? 40_000 }); // 1: anchor + 30,000 backing
  psbt.addOutput({ script: opts.carrierScript ?? walletScript, value: 1_000 }); // 2: carrier
  psbt.addOutput({ script: feeScript, value: Number(BUY.protocolFeeSats) }); // 3
  psbt.addOutput({ script: walletScript, value: opts.changeSats ?? 5_700 }); // 4: change
  return psbt;
}

function buyIntent(psbt: bitcoin.Psbt, overrides: Partial<ClientIntent> = {}): ClientIntent {
  const totalIn = psbt.data.inputs.reduce((s, i) => s + BigInt(i.witnessUtxo?.value ?? 0), 0n);
  const totalOut = psbt.txOutputs.reduce((s, o) => s + BigInt(o.value), 0n);
  return {
    operation: "BACKING_BUY",
    tokenId: TOKEN_ID_HEX,
    tokenAmountAtoms: AMOUNT_ATOMS.toString(),
    grossSats: BUY.grossSats.toString(),
    protocolFeeSats: BUY.protocolFeeSats.toString(),
    minerFeeSats: (totalIn - totalOut).toString(),
    netSats: null,
    walletScript: walletScript.toString("hex"),
    stateHash: "cd".repeat(32),
    unsignedTxDigest: unsignedTxDigestHex(psbt),
    ...overrides,
  };
}

describe("verifyClientIntent — BTC re-derivation (§M3)", () => {
  it("accepts a redeem whose PSBT matches the intent", () => {
    const psbt = buildRedeemPsbt();
    const result = verifyClientIntent(psbt.toBase64(), redeemIntent(psbt));
    // Payout less the miner fee, less the carrier that was spent and not returned.
    expect(result.walletDeltaSats).toBe(REDEEM.netSats - REDEEM.minerFeeSats);
  });

  it("rejects a redeem whose payout is redirected to an attacker", () => {
    const psbt = buildRedeemPsbt({ payoutScript: attackerScript });
    expect(() => verifyClientIntent(psbt.toBase64(), redeemIntent(psbt))).toThrow(
      /CLIENT_INTENT_MISMATCH/,
    );
  });

  it("rejects an understated miner fee", () => {
    const psbt = buildRedeemPsbt();
    expect(() =>
      verifyClientIntent(psbt.toBase64(), redeemIntent(psbt, { minerFeeSats: "0" })),
    ).toThrow(/miner fee/);
  });

  it("rejects a missing protocol fee output", () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    psbt.addInput({
      hash: "22".repeat(32),
      index: 0,
      witnessUtxo: { script: walletScript, value: 50_000 },
    });
    psbt.addOutput({ script: walletScript, value: 20_790 });
    expect(() =>
      verifyClientIntent(
        psbt.toBase64(),
        redeemIntent(psbt, { minerFeeSats: "29210", protocolFeeSats: "210" }),
      ),
    ).toThrow(/protocol fee output missing/);
  });

  it("accepts a buy whose PSBT matches the intent", () => {
    const psbt = buildMintPsbt();
    const result = verifyClientIntent(psbt.toBase64(), buyIntent(psbt));
    expect(result.walletDeltaSats).toBe(-(BUY.grossSats + BUY.protocolFeeSats + BUY.minerFeeSats));
  });

  it("rejects a buy that quietly costs more than the price it showed", () => {
    // Same miner fee, same protocol fee, same token amount. The vault simply
    // takes 5,000 sats more than the quoted price and the change shrinks to
    // match, so nothing but the balance check can catch it.
    const psbt = buildMintPsbt({ vaultOutSats: 45_000, changeSats: 700 });
    expect(() => verifyClientIntent(psbt.toBase64(), buyIntent(psbt))).toThrow(
      /buying costs 38300 sats, not the 33300/,
    );
  });

  it("rejects a stated wallet delta that does not match the transaction", () => {
    const psbt = buildMintPsbt();
    expect(() =>
      verifyClientIntent(psbt.toBase64(), buyIntent(psbt, { walletDeltaSats: "-1" })),
    ).toThrow(/wallet balance changes by/);
  });
});

describe("verifyClientIntent — token delivery (§M3)", () => {
  it("rejects a buy that mints fewer tokens than the user asked for", () => {
    // Every satoshi is correct. Only the envelope is short.
    const psbt = buildMintPsbt({ envelopeAmount: 1n });
    expect(() => verifyClientIntent(psbt.toBase64(), buyIntent(psbt))).toThrow(
      /mints 1 atoms, not the 4200000000000000/,
    );
  });

  it("rejects a buy whose carrier output is handed to someone else", () => {
    // Sending the carrier elsewhere cannot be hidden: it necessarily breaks
    // either the balance identity or the miner fee, whichever the attacker
    // chooses to leave alone. Both are refusals, so assert the refusal itself.
    const psbt = buildMintPsbt({ carrierScript: attackerScript });
    expect(() => verifyClientIntent(psbt.toBase64(), buyIntent(psbt))).toThrow(
      /CLIENT_INTENT_MISMATCH/,
    );
  });

  it("rejects a buy whose envelope points the tokens at another output", () => {
    // recipientVout 3 is the protocol fee output, not the buyer's carrier.
    const psbt = buildMintPsbt({ recipientVout: 3 });
    expect(() => verifyClientIntent(psbt.toBase64(), buyIntent(psbt))).toThrow(
      /output 3, which is not your wallet/,
    );
  });

  it("rejects a buy for a different token than the one on screen", () => {
    const psbt = buildMintPsbt();
    expect(() =>
      verifyClientIntent(psbt.toBase64(), buyIntent(psbt, { tokenId: "ef".repeat(32) })),
    ).toThrow(/moves token/);
  });

  it("rejects a redeem that burns more tokens than the user asked for", () => {
    const psbt = buildRedeemPsbt({ envelopeAmount: AMOUNT_ATOMS * 2n });
    expect(() => verifyClientIntent(psbt.toBase64(), redeemIntent(psbt))).toThrow(/redeems/);
  });

  it("refuses a Cove-magic envelope it cannot parse, instead of ignoring it", () => {
    // A corrupted or future-version envelope must stop the signature. Skipping
    // past an unreadable Cove payload is how an unchecked transaction gets
    // signed — the browser hit exactly this when Buffer was missing.
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    psbt.addInput({
      hash: "22".repeat(32),
      index: 0,
      witnessUtxo: { script: vaultScript, value: 110_000 },
    });
    psbt.addInput({
      hash: "33".repeat(32),
      index: 0,
      witnessUtxo: { script: walletScript, value: 1_000 },
    });
    // "CV" magic, version 9 — right family, unreadable content.
    psbt.addOutput({ script: opReturn(Buffer.from("4356090300000000", "hex")), value: 0 });
    psbt.addOutput({ script: vaultScript, value: 89_000 });
    psbt.addOutput({ script: walletScript, value: Number(REDEEM.netSats) });
    psbt.addOutput({ script: feeScript, value: Number(REDEEM.protocolFeeSats) });
    expect(() => verifyClientIntent(psbt.toBase64(), redeemIntent(psbt))).toThrow(/unreadable/);
  });

  it("rejects a token-moving transaction with no Cove envelope at all", () => {
    const psbt = buildRedeemPsbt({ omitEnvelope: true });
    expect(() => verifyClientIntent(psbt.toBase64(), redeemIntent(psbt))).toThrow(
      /no Cove envelope/,
    );
  });
});

/**
 * A real wallet has two addresses: nested segwit or native segwit for BTC, and
 * Taproot for ordinals. A check that knew only about the payment address read
 * the token carrier as money leaving the wallet and refused every buy.
 */
describe("verifyClientIntent — two-address wallets", () => {
  const ordinals = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0x77)]);

  function buildTwoAddressMint(): bitcoin.Psbt {
    const wire = encodeMintV2({ tokenId: TOKEN_ID, amount: AMOUNT_ATOMS, recipientVout: 2 });
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    psbt.addInput({
      hash: "44".repeat(32),
      index: 0,
      witnessUtxo: { script: vaultScript, value: 10_000 },
    });
    psbt.addInput({
      hash: "55".repeat(32),
      index: 0,
      witnessUtxo: { script: walletScript, value: 40_000 },
    });
    psbt.addOutput({ script: opReturn(wire), value: 0 }); // 0
    psbt.addOutput({ script: vaultScript, value: 40_000 }); // 1
    psbt.addOutput({ script: ordinals, value: 1_000 }); // 2: carrier, Taproot
    psbt.addOutput({ script: feeScript, value: Number(BUY.protocolFeeSats) }); // 3
    psbt.addOutput({ script: walletScript, value: 5_700 }); // 4: BTC change
    return psbt;
  }

  it("accepts a buy whose tokens land on the ordinals address", () => {
    const psbt = buildTwoAddressMint();
    const result = verifyClientIntent(psbt.toBase64(), {
      ...buyIntent(psbt),
      ordinalsScript: ordinals.toString("hex"),
    });
    // The carrier sats are still the wallet's, so the cost is unchanged.
    expect(result.walletDeltaSats).toBe(-(BUY.grossSats + BUY.protocolFeeSats + BUY.minerFeeSats));
  });

  it("still refuses tokens delivered to an address the wallet does not own", () => {
    const psbt = buildTwoAddressMint();
    expect(() =>
      verifyClientIntent(psbt.toBase64(), {
        ...buyIntent(psbt),
        ordinalsScript: Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0x99)]).toString(
          "hex",
        ),
      }),
    ).toThrow(/CLIENT_INTENT_MISMATCH/);
  });

  it("requires a redeem payout on the payments address, not the ordinals one", () => {
    const psbt = buildRedeemPsbt({ payoutScript: ordinals });
    expect(() =>
      verifyClientIntent(psbt.toBase64(), {
        ...redeemIntent(psbt),
        ordinalsScript: ordinals.toString("hex"),
      }),
    ).toThrow(/payout to your wallet/);
  });
});

describe("small redemption with wallet-funded fees", () => {
  function smallRedeem() {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    psbt.addInput({
      hash: "22".repeat(32),
      index: 1,
      witnessUtxo: { script: vaultScript, value: 10027 },
    });
    psbt.addInput({
      hash: "33".repeat(32),
      index: 2,
      witnessUtxo: { script: walletScript, value: 1000 },
    });
    psbt.addInput({
      hash: "44".repeat(32),
      index: 0,
      witnessUtxo: { script: walletScript, value: 10000 },
    });
    psbt.addOutput({
      script: opReturn(
        encodeRedeemV2({ tokenId: TOKEN_ID, redeemAmount: 100000000000n, changeAllocations: [] }),
      ),
      value: 0,
    });
    psbt.addOutput({ script: vaultScript, value: 10000 });
    psbt.addOutput({ script: walletScript, value: 9027 });
    psbt.addOutput({ script: feeScript, value: 1000 });
    const intent = redeemIntent(psbt, {
      tokenAmountAtoms: "100000000000",
      grossSats: "27",
      protocolFeeSats: "1000",
      minerFeeSats: "1000",
      netSats: "-973",
      payoutSats: "9027",
    });
    return { psbt, intent };
  }
  it("verifies the negative economic result and returns payout plus change to the wallet", () => {
    const { psbt, intent } = smallRedeem();
    expect(verifyClientIntent(psbt.toBase64(), intent).walletDeltaSats).toBe(-1973n);
  });
  it("rejects a redirected or misstated combined payout before signing", () => {
    const { psbt, intent } = smallRedeem();
    expect(() => verifyClientIntent(psbt.toBase64(), { ...intent, payoutSats: "9028" })).toThrow();
    const wrong = bitcoin.Psbt.fromBase64(psbt.toBase64());
    (wrong as any).__CACHE.__TX.outs[2].script = feeScript;
    expect(() =>
      verifyClientIntent(wrong.toBase64(), {
        ...intent,
        unsignedTxDigest: unsignedTxDigestHex(wrong),
      }),
    ).toThrow();
    expect(() => verifyClientIntent(psbt.toBase64(), { ...intent, netSats: "27" })).toThrow();
  });
});
