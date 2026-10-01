import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { describe, expect, it } from "vitest";
import { finalizeCrcPsbt } from "./crc-submit";

describe("CRC PSBT finalization", () => {
  it("keeps the Guardian's finalized vault witness while finalizing wallet funding", () => {
    const wallet = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x31));
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    const vaultWitness = Buffer.from([1, 1, 0x51]);
    psbt.addInput({
      hash: "a".repeat(64), index: 0,
      witnessUtxo: { script: Buffer.from(`5120${"22".repeat(32)}`, "hex"), value: 330 },
      finalScriptWitness: vaultWitness,
    });
    psbt.addInput({
      hash: "b".repeat(64), index: 0,
      witnessUtxo: { script: bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!, value: 10_000 },
    });
    psbt.addOutput({ script: bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!, value: 9_330 });
    psbt.signInput(1, wallet);

    const tx = finalizeCrcPsbt(psbt);
    expect(tx.ins[0]!.witness).toEqual([Buffer.from([0x51])]);
    expect(tx.ins[1]!.witness).toHaveLength(2);
    expect(psbt.data.inputs[0]!.finalScriptWitness).toEqual(vaultWitness);
  });
});
