import { expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt } from "@crclaunch/crc20-adapters";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { signCrcBuildSession } from "./crc-browser-session";
const key = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 1));
const payment = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest });
const script = payment.output!.toString("hex");
const config = { network: "regtest", ticker: "TEST", vaultScriptHex: `0014${"11".repeat(20)}`, creatorScriptHex: script, protocolScriptHex: `0014${"22".repeat(20)}` };
const input = { txid: "aa".repeat(32), vout: 0, sats: 20000n, scriptHex: script };
const plan = core.buildDeploy({ config, funding: [input], changeScriptHex: script, minerFeeSats: 400n });
const built = { sessionId: "session", psbtBase64: createPlanPsbt(plan, "regtest").toBase64(), intent: {
  operation: "deploy", ticker: "TEST", minerFeeSats: 400, launchFeeSats: 7000, creatorRecordSats: 1000, vaultAnchorSats: 1000,
  corePlan: core.encodeProtocolDto(plan), coreConfig: core.encodeProtocolDto(config),
} };
const wallet = { network: "regtest", address: payment.address!, publicKey: key.publicKey.toString("hex"), ordinalsAddress: payment.address!, ordinalsPublicKey: key.publicKey.toString("hex") };
const request = vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true, data: url.includes("trading/status") ? { network: "regtest", protocolScriptHex: config.protocolScriptHex } : url.includes("funding-check") ? { tokenFreeOutpoints: [{ txid: input.txid, vout: input.vout }] } :
  { utxos: [{ txid: input.txid, vout: 0, valueSats: "20000", confirmations: 1 }] } })));
const review = { operation: "deploy" as const, ticker: "TEST", minerFeeSats: 400 };
test("rebuilds deployment from independently observed funding and reviewed ticker/fee", async () => {
  const signer = vi.fn(async (base64: string) => { const p = bitcoin.Psbt.fromBase64(base64); p.signAllInputs(key); return p.toBase64(); });
  await expect(signCrcBuildSession(built, review, wallet, signer, request)).resolves.toEqual(expect.any(String));
  expect(signer).toHaveBeenCalledOnce();
});
test("rejects forged plan economics, authority, amount display or user identity before a prompt", async () => {
  const signer = vi.fn();
  for (const forged of [
    { ...built, intent: { ...built.intent, launchFeeSats: 6000 } },
    { ...built, intent: { ...built.intent, coreConfig: { ...built.intent.coreConfig, protocolScriptHex: script } } },
    { ...built, intent: { ...built.intent, corePlan: core.encodeProtocolDto({ ...plan, inputs: [{ ...input, sats: 21000n }] }) } },
  ]) await expect(signCrcBuildSession(forged, review, wallet, signer, request)).rejects.toThrow();
  await expect(signCrcBuildSession(built, { ...review, ticker: "EVIL" }, wallet, signer, request)).rejects.toThrow();
  await expect(signCrcBuildSession(built, { ...review, minerFeeSats: 401 }, wallet, signer, request)).rejects.toThrow();
  expect(signer).not.toHaveBeenCalled();
});

test("validates the actual Xverse wallet-first mint response with unsigned server vault metadata", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../../../artifacts/crc-core-integration/wallet-capabilities/", import.meta.url);
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
  const f = core.decodeProtocolDto<{ state: core.Asset; plan: core.Plan }>(read("xverse-core-mint-request.json"));
  const account = read("xverse-nested-connect.json").value.result.addresses.find((a: { purpose: string }) => a.purpose === "payment");
  const original = createPlanPsbt(f.plan, "signet", { publicKeys: { 1: account.publicKey } });
  const response = bitcoin.Psbt.fromBase64(read("xverse-core-mint-response.json").value.result.psbt);
  delete response.data.inputs[0]!.finalScriptWitness;
  const request = vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true, data: url.includes("/wallet/utxos") ?
    { utxos: [{ txid: f.plan.inputs[1]!.txid, vout: f.plan.inputs[1]!.vout, valueSats: core.sats(f.plan.inputs[1]!.sats).toString(), confirmations: 1 }] } :
    url.includes("funding-check") ? { tokenFreeOutpoints: [{ txid: f.plan.inputs[1]!.txid, vout: f.plan.inputs[1]!.vout }] } :
    { token: { coreState: core.encodeProtocolDto(f.state) }, indexedTip: { height: "100", blockHash: "11".repeat(32) } } })));
  const session = { sessionId: "xverse-session", psbtBase64: original.toBase64(), intent: { operation: "mint-buy", assetId: `signet:${f.state.deployTxid}`, amountAtoms: "10000000000", minerFeeSats: Number(f.plan.minerFeeSats), coreConfig: core.encodeProtocolDto(f.state.config), corePlan: core.encodeProtocolDto(f.plan) } };
  const signer = vi.fn(async () => response.toBase64());
  const signed = await signCrcBuildSession(session, { operation: "buy", assetId: session.intent.assetId, amountAtoms: session.intent.amountAtoms, minerFeeSats: session.intent.minerFeeSats },
    { network: "signet", address: account.address, publicKey: account.publicKey, ordinalsAddress: account.address, ordinalsPublicKey: account.publicKey }, signer, request);
  expect(signer).toHaveBeenCalledOnce();
  expect(bitcoin.Psbt.fromBase64(signed).data.inputs[0]!.finalScriptWitness).toBeUndefined();
  expect(bitcoin.Psbt.fromBase64(signed).data.inputs[1]!.finalScriptWitness).toBeDefined();
});

test("launch creator identity follows the payment account when token account differs", async () => {
  const secondKey = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 2));
  const second = bitcoin.payments.p2wpkh({ pubkey: secondKey.publicKey, network: bitcoin.networks.regtest });
  const dualWallet = { ...wallet, ordinalsAddress: second.address!, ordinalsPublicKey: secondKey.publicKey.toString("hex") };
  const dualRequest = vi.fn(async (url: string) => url.includes(encodeURIComponent(second.address!))
    ? new Response(JSON.stringify({ ok: true, data: { utxos: [] } })) : request(url));
  const signer = vi.fn(async (base64: string) => { const p = bitcoin.Psbt.fromBase64(base64); p.signAllInputs(key); return p.toBase64(); });
  await expect(signCrcBuildSession(built, review, dualWallet, signer, dualRequest)).resolves.toEqual(expect.any(String));
  expect(signer).toHaveBeenCalledOnce();
});

test("exact sell review credits released token carriers instead of using advisory economics", async () => {
  const { crcBuiltWalletDelta } = await import("./crc-browser-session");
  const state: core.Asset = { config, deployTxid: "bb".repeat(32), issuedAtoms: 1000n * core.atomsPerToken, inventoryAtoms: 0n, burnedAtoms: 0n,
    vault: { txid: "cc".repeat(32), vout: 0, sats: 1027n, scriptHex: config.vaultScriptHex } };
  const tokens = { txid: "dd".repeat(32), vout: 0, sats: 1000n, scriptHex: script, atoms: state.issuedAtoms, deployTxid: state.deployTxid };
  const sell = core.buildSell({ state, inputs: [tokens], funding: [input], amountAtoms: state.issuedAtoms, recipientScriptHex: script, changeScriptHex: script, minerFeeSats: 400n });
  expect(core.quoteSell(state, state.issuedAtoms).economicSats - 400n).toBe(-1373n);
  expect(crcBuiltWalletDelta({ sessionId: "sell", psbtBase64: "", intent: { operation: "sell", corePlan: core.encodeProtocolDto(sell) } })).toBe(373n);
});

test("rejects observed token carriers disguised as ordinary final-plan funding before any signature", async () => {
  const carrier = { ...input, txid: "bb".repeat(32), sats: 1000n };
  const unsafe = core.buildDeploy({ config, funding: [input, carrier], changeScriptHex: script, minerFeeSats: 400n });
  const malicious = { ...built, psbtBase64: createPlanPsbt(unsafe, "regtest").toBase64(), intent: { ...built.intent, corePlan: core.encodeProtocolDto(unsafe) } };
  const observed = vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true, data: url.includes("trading/status")
    ? { network: "regtest", protocolScriptHex: config.protocolScriptHex }
    : url.includes("funding-check") ? { tokenFreeOutpoints: [{ txid: input.txid, vout: input.vout }] }
    : { utxos: [input, carrier].map((coin) => ({ txid: coin.txid, vout: coin.vout, valueSats: coin.sats.toString(), confirmations: 1 })) } })));
  const signer = vi.fn(async (base64: string) => { const psbt = bitcoin.Psbt.fromBase64(base64); psbt.signAllInputs(key); return psbt.toBase64(); });
  await expect(signCrcBuildSession(malicious, review, wallet, signer, observed)).rejects.toThrow(/token|funding/i);
  expect(signer).not.toHaveBeenCalled();
});
