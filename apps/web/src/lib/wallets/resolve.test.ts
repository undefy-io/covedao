import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { browserNetwork, inputsOwnedBy, splitAddresses } from "./resolve";
import { WalletError } from "./types";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.testnet;

const buyerKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x61), { network: NET });
const payments = bitcoin.payments.p2sh({
  redeem: bitcoin.payments.p2wpkh({ pubkey: buyerKey.publicKey, network: NET }),
  network: NET,
});
const ordinals = bitcoin.payments.p2tr({
  internalPubkey: Buffer.from(buyerKey.publicKey.subarray(1, 33)),
  network: NET,
});
const vault = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0x11)]);

const connection = {
  payments: { address: payments.address!, script: payments.output!.toString("hex"), publicKey: "" },
  ordinals: { address: ordinals.address!, script: ordinals.output!.toString("hex"), publicKey: "" },
};

describe("browserNetwork", () => {
  it("refuses regtest with an explanation rather than a silent failure", () => {
    expect(() => browserNetwork("regtest")).toThrow(WalletError);
    expect(() => browserNetwork("regtest")).toThrow(/do not support regtest/);
  });

  it("passes through the three networks wallets do support", () => {
    expect(browserNetwork("mainnet")).toBe("mainnet");
    expect(browserNetwork("testnet")).toBe("testnet");
    expect(browserNetwork("signet")).toBe("signet");
  });
});

describe("splitAddresses", () => {
  it("routes Taproot to ordinals and the rest to payments", () => {
    const split = splitAddresses(
      [
        { address: payments.address!, publicKey: "aa", format: "p2sh-p2wpkh" },
        { address: ordinals.address!, publicKey: "bb", format: "taproot" },
      ],
      "testnet",
    );
    expect(split.payments.address).toBe(payments.address);
    expect(split.ordinals.address).toBe(ordinals.address);
  });

  it("uses one address for both roles when that is all the wallet has", () => {
    const only = bitcoin.payments.p2wpkh({ pubkey: buyerKey.publicKey, network: NET });
    const split = splitAddresses([{ address: only.address!, publicKey: "cc", format: "segwit" }], "testnet");
    expect(split.payments.address).toBe(only.address);
    expect(split.ordinals.address).toBe(only.address);
  });

  it("derives the script from the address rather than trusting the wallet", () => {
    const split = splitAddresses(
      [{ address: ordinals.address!, publicKey: "bb", format: "taproot" }],
      "testnet",
    );
    expect(split.ordinals.script).toBe(ordinals.output!.toString("hex"));
  });

  it("refuses an address from the wrong network instead of deriving nonsense", () => {
    const mainnet = bitcoin.payments.p2wpkh({
      pubkey: buyerKey.publicKey,
      network: bitcoin.networks.bitcoin,
    });
    expect(() =>
      splitAddresses([{ address: mainnet.address!, publicKey: "dd", format: "segwit" }], "testnet"),
    ).toThrow(/not a testnet address/);
  });
});

describe("inputsOwnedBy", () => {
  /** A mint: the vault at index 0, then the buyer's own funding input. */
  function mintPsbt(): string {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: "11".repeat(32), index: 1, witnessUtxo: { script: vault, value: 50_000 } });
    psbt.addInput({
      hash: "22".repeat(32),
      index: 0,
      witnessUtxo: { script: payments.output!, value: 100_000 },
    });
    psbt.addOutput({ script: ordinals.output!, value: 1_000 });
    return psbt.toBase64();
  }

  it("never offers the backing vault input to the wallet", () => {
    // The Guardian has already signed input 0. A wallet asked to sign it would
    // either fail or produce a signature that invalidates the transaction.
    const groups = inputsOwnedBy(mintPsbt(), "testnet", connection);
    const offered = groups.flatMap((g) => g.indexes);
    expect(offered).not.toContain(0);
    expect(offered).toEqual([1]);
  });

  it("groups each input under the address that owns it", () => {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: "11".repeat(32), index: 1, witnessUtxo: { script: vault, value: 50_000 } });
    psbt.addInput({
      hash: "22".repeat(32),
      index: 0,
      witnessUtxo: { script: ordinals.output!, value: 1_000 },
    });
    psbt.addInput({
      hash: "33".repeat(32),
      index: 0,
      witnessUtxo: { script: payments.output!, value: 100_000 },
    });
    psbt.addOutput({ script: payments.output!, value: 90_000 });

    const groups = inputsOwnedBy(psbt.toBase64(), "testnet", connection);
    const byAddress = Object.fromEntries(groups.map((g) => [g.address, g.indexes]));
    expect(byAddress[ordinals.address!]).toEqual([1]);
    expect(byAddress[payments.address!]).toEqual([2]);
  });

  it("returns nothing when no input belongs to the wallet", () => {
    const psbt = new bitcoin.Psbt({ network: NET });
    psbt.addInput({ hash: "11".repeat(32), index: 1, witnessUtxo: { script: vault, value: 50_000 } });
    psbt.addOutput({ script: payments.output!, value: 40_000 });
    expect(inputsOwnedBy(psbt.toBase64(), "testnet", connection)).toEqual([]);
  });
  it("never asks a wallet to replace a finalized seller witness on a self purchase", () => {
    const psbt = bitcoin.Psbt.fromBase64(mintPsbt());
    psbt.data.inputs[1]!.finalScriptWitness = Buffer.from("010151", "hex");
    expect(inputsOwnedBy(psbt.toBase64(), "testnet", connection)).toEqual([]);
  });

});
