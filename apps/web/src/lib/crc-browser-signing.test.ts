import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt } from "@crclaunch/crc20-adapters";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { signCrcReviewedPlan } from "./crc-browser-signing";

const key = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 1));
const payment = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest });
const account = { address: payment.address!, publicKey: key.publicKey.toString("hex") };
const script = payment.output!.toString("hex");
const config = { network: "regtest", ticker: "TEST", vaultScriptHex: `0014${"11".repeat(20)}`,
  creatorScriptHex: script, protocolScriptHex: `0014${"22".repeat(20)}` };
const plan = core.buildDeploy({ config, funding: [{ txid: "aa".repeat(32), vout: 0, sats: 20000n, scriptHex: script }],
  changeScriptHex: script, minerFeeSats: 400n });
const psbtBase64 = createPlanPsbt(plan, "regtest").toBase64();
const context = { plan, psbtBase64, ledger: core.emptyLedger(config), network: "regtest", accounts: [account], operation: "CRC_LAUNCH" };

describe("core browser signing boundary", () => {
  it("checks the reviewed core plan then verifies actual wallet signatures", async () => {
    const signer = vi.fn(async (base64: string) => {
      const psbt = bitcoin.Psbt.fromBase64(base64);
      psbt.signAllInputs(key);
      return psbt.toBase64();
    });
    const signed = await signCrcReviewedPlan(context, signer);
    expect(signer).toHaveBeenCalledOnce();
    expect(bitcoin.Psbt.fromBase64(signed).data.inputs[0]?.finalScriptWitness).toBeDefined();
  });
  it("rejects changed outputs or prevout amounts before a wallet prompt", async () => {
    const signer = vi.fn();
    const altered = createPlanPsbt({ ...plan, outputs: plan.outputs.map((o, i) => i === 2 ? { ...o, sats: o.sats + 1n } : o) }, "regtest");
    await expect(signCrcReviewedPlan({ ...context, psbtBase64: altered.toBase64() }, signer)).rejects.toThrow();
    const wrongPrevout = bitcoin.Psbt.fromBase64(psbtBase64);
    wrongPrevout.data.inputs[0]!.witnessUtxo!.value++;
    await expect(signCrcReviewedPlan({ ...context, psbtBase64: wrongPrevout.toBase64() }, signer)).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });
  it("rejects missing ownership, wrong network and unsupported input scripts before a prompt", async () => {
    const signer = vi.fn();
    await expect(signCrcReviewedPlan({ ...context, accounts: [] }, signer)).rejects.toThrow();
    await expect(signCrcReviewedPlan({ ...context, network: "signet" }, signer)).rejects.toThrow();
    await expect(signCrcReviewedPlan({ ...context, plan: { ...plan, inputs: [{ ...plan.inputs[0]!, scriptHex: "51" }] } }, signer)).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });
  it("propagates rejection and refuses a wallet response that changes the transaction", async () => {
    const rejection = new Error("User rejected");
    await expect(signCrcReviewedPlan(context, async () => { throw rejection; })).rejects.toBe(rejection);
    const changed = createPlanPsbt({ ...plan, outputs: plan.outputs.map((o, i) => i === 2 ? { ...o, sats: o.sats + 1n } : o) }, "regtest");
    await expect(signCrcReviewedPlan(context, async () => changed.toBase64())).rejects.toThrow();
  });
});
