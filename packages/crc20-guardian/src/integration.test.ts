import { beforeAll, afterAll, test, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import * as state from "@crclaunch/crc20-state";
import {
  buildCrc20AssetVault,
  crc20DeploymentTag,
  crc20AssetCommitment,
  dev1RecoveryProfile,
} from "@crclaunch/cove-vault";
import {
  Core,
  aliceKey,
  aliceScript,
  bobScript,
  protocolScript,
} from "../../cove-market/crc20-protocol/test-support/core.js";
import { isolatedDatabase } from "../../cove-indexer/src/crc20/test-support/database.js";
import { syncCrcTip } from "../../cove-indexer/src/crc20/runner.js";
import { TestGuardianCustodyBackend } from "../../cove-guardian/src/v3/custody.js";
import { guardianPsbtTransaction } from "@crclaunch/crc20-adapters";
import { CrcGuardianSigningService } from "./index.js";
let database: Awaited<ReturnType<typeof isolatedDatabase>>;
const node = new Core();
const backend = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x41));
const sign = vi.spyOn(backend, "signTaprootScriptPath");
let lastBuy: { request: ReturnType<typeof request>; rawHex: string; blockHash: string };
const evidence: unknown[] = [];
let config: core.Config,
  activationHeight: number,
  deployId: string,
  service: CrcGuardianSigningService;
const recoveryProfile = dev1RecoveryProfile(Buffer.from(aliceKey.publicKey).subarray(1));
const provider = {
  async getBlockchainInfo() {
    const info = node.rpc("getblockchaininfo");
    return { chain: info.chain, blocks: info.blocks, bestBlockHash: info.bestblockhash };
  },
  async getBlockHash(height: number) {
    return node.rpc("getblockhash", [height]);
  },
  async getBlock(hash: string) {
    const block = node.rpc("getblock", [hash, 1]);
    return {
      hash,
      height: block.height,
      previousBlockHash: block.previousblockhash,
      timestamp: block.time,
      txids: block.tx,
      rawTxs: block.tx.map((id: string) => node.rpc("getrawtransaction", [id, false, hash])),
    };
  },
  async getRawTransaction(txid: string) {
    return node.rpc("getrawtransaction", [txid]);
  },
  async getTxout(txid: string, vout: number, includeMempool: boolean) {
    const out = node.rpc("gettxout", [txid, vout, includeMempool]);
    return out
      ? {
          scriptPubKeyHex: out.scriptPubKey.hex,
          valueSats: BigInt(Math.round(out.value * 1e8)),
          confirmations: out.confirmations,
        }
      : null;
  },
};
const sync = async () =>
  (
    await syncCrcTip({
      db: database.db,
      provider,
      network: "regtest",
      activationHeight,
      protocolScriptHex: protocolScript,
    })
  ).snapshot.state!;
function walletPsbt(plan: core.Plan) {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  plan.inputs.forEach((input) =>
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: Buffer.from(input.scriptHex, "hex"), value: Number(input.sats) },
      sighashType: 1,
    }),
  );
  plan.outputs.forEach((output) =>
    psbt.addOutput({ script: Buffer.from(output.scriptHex, "hex"), value: Number(output.sats) }),
  );
  for (let index = 1; index < plan.inputs.length; index++) psbt.signInput(index, aliceKey);
  return psbt;
}
const request = (psbt: bitcoin.Psbt, operation: "mint-buy" | "sell" | "inventory-buy") => ({
  requestId: "isolated-core",
  network: "regtest",
  deploymentTxid: deployId,
  operation,
  psbtBase64: psbt.toBase64(),
});
beforeAll(async () => {
  database = await isolatedDatabase();
  node.start();
  const guardianXOnly = await backend.xOnlyPubkey();
  const assetIdentity = {
    deploymentTag: crc20DeploymentTag(Buffer.from(core.deployMarker("TEST"))),
    launchSalt: Buffer.alloc(32, 0x45),
  };
  const vault = buildCrc20AssetVault({
    asset: assetIdentity,
    guardianXOnly,
    recoveryProfile,
    network: bitcoin.networks.regtest,
  });
  config = core.guardianConfig(
    {
      network: "regtest",
      ticker: "TEST",
      vaultScriptHex: vault.scriptPubKey.toString("hex"),
      creatorScriptHex: bobScript,
      protocolScriptHex: protocolScript,
    },
    {
      assetCommitmentHex: crc20AssetCommitment(assetIdentity).toString("hex"),
      guardianPublicKeyHex: guardianXOnly.toString("hex"),
      executionScriptHex: vault.executionLeaf.script.toString("hex"),
      controlBlockHex: vault.executionControlBlock.toString("hex"),
      recoveryLeafHashHex: vault.recoveryLeaf.tapleafHash.toString("hex"),
    },
  );
  activationHeight = node.rpc("getblockcount") + 1;
  await state.initializeCrcLedger(database.db, config, { activationHeight });
  const plan = core.buildDeploy({
    config,
    funding: [node.funding("alice")],
    changeScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const raw = node.sign(plan);
  expect(node.accepted(raw).allowed).toBe(true);
  deployId = await state.saveCrcRegistration(database.db, config, {
    rawHex: raw,
    prevouts: plan.inputs,
  });
  node.broadcast(raw);
  node.mine();
  await sync();
  service = new CrcGuardianSigningService({
    db: database.db,
    core: provider,
    custodyBackend: backend,
    guardianXOnly,
    recoveryProfile,
    network: "regtest",
    protocolScript: Buffer.from(protocolScript, "hex"),
    maxMinerFeeSats: 20000n,
  });
  await service.probe();
}, 60000);
afterAll(async () => {
  if (process.env.CRC_GUARDIAN_EVIDENCE && evidence.length === 3) {
    mkdirSync(dirname(process.env.CRC_GUARDIAN_EVIDENCE), { recursive: true });
    writeFileSync(
      process.env.CRC_GUARDIAN_EVIDENCE,
      JSON.stringify(
        { network: "regtest", publicTestKeysOnly: true, transactions: evidence },
        (_, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ) + "\n",
    );
  }
  node.stop();
  if (database) await database.close();
}, 30000);
test("real Guardian custody mines core mint/sell/inventory buy with exact fees and indexed state", async () => {
  let ledger = await sync();
  const mint = core.buildMint({
    state: ledger.assets[deployId]!,
    funding: [node.funding("alice")],
    amountAtoms: 100000000000n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const psbt = walletPsbt(mint);
  const mintExpected = core.validateGuardianTransaction(
    ledger,
    guardianPsbtTransaction(psbt),
  ).ledger;
  const signed = await service.sign(request(psbt, "mint-buy"));
  expect(signed).toMatchObject({ ok: true });
  if (!signed.ok) throw new Error(signed.detail);
  const same = await service.sign(request(psbt, "mint-buy"));
  expect(same).toEqual(signed);
  expect(sign).toHaveBeenCalledTimes(1);
  const complete = guardianPsbtTransaction(bitcoin.Psbt.fromBase64(signed.signedPsbtBase64));
  core.validateFinalTransaction(mint, complete, ledger);
  expect(node.accepted(complete.rawHex).allowed).toBe(true);
  const mintId = node.broadcast(complete.rawHex);
  node.mine();
  ledger = await sync();
  expect(ledger.assets).toEqual(mintExpected.assets);
  expect(ledger.allocations).toEqual(mintExpected.allocations);
  evidence.push({
    kind: "mint",
    plan: mint,
    rawHex: complete.rawHex,
    assets: ledger.assets,
    allocations: ledger.allocations,
  });
  expect(ledger.assets[deployId]!.issuedAtoms).toBe(100000000000n);
  expect(ledger.allocations[`${mintId}:1`]!.atoms).toBe(100000000000n);
  const sell = core.buildSell({
    state: ledger.assets[deployId]!,
    inputs: [{ txid: mintId, vout: 1, ...ledger.allocations[`${mintId}:1`]! }],
    funding: [node.funding("alice")],
    amountAtoms: 100000000000n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const sellPsbt = walletPsbt(sell);
  const sellExpected = core.validateGuardianTransaction(
    ledger,
    guardianPsbtTransaction(sellPsbt),
  ).ledger;
  const sellResult = await service.sign(request(sellPsbt, "sell"));
  expect(sellResult).toMatchObject({ ok: true });
  if (!sellResult.ok) throw new Error(sellResult.detail);
  const sold = guardianPsbtTransaction(bitcoin.Psbt.fromBase64(sellResult.signedPsbtBase64));
  core.validateFinalTransaction(sell, sold, ledger);
  expect(node.accepted(sold.rawHex).allowed).toBe(true);
  node.broadcast(sold.rawHex);
  node.mine();
  ledger = await sync();
  expect(ledger.assets).toEqual(sellExpected.assets);
  expect(ledger.allocations).toEqual(sellExpected.allocations);
  evidence.push({
    kind: "sell",
    plan: sell,
    rawHex: sold.rawHex,
    assets: ledger.assets,
    allocations: ledger.allocations,
  });
  expect(ledger.assets[deployId]!.inventoryAtoms).toBe(100000000000n);
  const buy = core.buildInventoryBuy({
    state: ledger.assets[deployId]!,
    funding: [node.funding("alice")],
    amountAtoms: 100000000000n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const buyPsbt = walletPsbt(buy);
  const buyExpected = core.validateGuardianTransaction(
    ledger,
    guardianPsbtTransaction(buyPsbt),
  ).ledger;
  const buyResult = await service.sign(request(buyPsbt, "inventory-buy"));
  expect(buyResult).toMatchObject({ ok: true });
  if (!buyResult.ok) throw new Error(buyResult.detail);
  const bought = guardianPsbtTransaction(bitcoin.Psbt.fromBase64(buyResult.signedPsbtBase64));
  core.validateFinalTransaction(buy, bought, ledger);
  expect(node.accepted(bought.rawHex).allowed).toBe(true);
  node.broadcast(bought.rawHex);
  const buyHash = node.mine()[0];
  ledger = await sync();
  expect(ledger.assets).toEqual(buyExpected.assets);
  expect(ledger.allocations).toEqual(buyExpected.allocations);
  evidence.push({
    kind: "inventoryBuy",
    plan: buy,
    rawHex: bought.rawHex,
    assets: ledger.assets,
    allocations: ledger.allocations,
  });
  lastBuy = {
    request: request(buyPsbt, "inventory-buy"),
    rawHex: bought.rawHex,
    blockHash: buyHash,
  };
  expect(ledger.assets[deployId]!.inventoryAtoms).toBe(0n);
  expect(ledger.assets[deployId]!.burnedAtoms).toBe(0n);
  expect(
    Object.values(ledger.allocations).reduce((total, allocation) => total + allocation.atoms, 0n),
  ).toBe(100000000000n);
}, 60000);
test("bad wallet/state/fees/recovery/stale vault never reach custody", async () => {
  const ledger = await sync();
  const plan = core.buildMint({
    state: ledger.assets[deployId]!,
    funding: [node.funding("alice")],
    amountAtoms: 100000000000n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const unsigned = walletPsbt(plan);
  delete unsigned.data.inputs[1]!.partialSig;
  const count = sign.mock.calls.length;
  expect(await service.sign(request(unsigned, "mint-buy"))).toMatchObject({ ok: false });
  expect(sign).toHaveBeenCalledTimes(count);
  const changed = walletPsbt(plan);
  changed.data.inputs[1]!.witnessUtxo!.value++;
  expect(await service.sign(request(changed, "mint-buy"))).toMatchObject({ ok: false });
  expect(sign).toHaveBeenCalledTimes(count);
  const wrongOperation = await service.sign(request(walletPsbt(plan), "sell"));
  expect(wrongOperation).toMatchObject({ ok: false });
  expect(sign).toHaveBeenCalledTimes(count);
  const wrongFees = {
    ...plan,
    outputs: plan.outputs.map((output, index) =>
      index === 3
        ? { ...output, sats: output.sats + 1n }
        : index === plan.outputs.length - 1
          ? { ...output, sats: output.sats - 1n }
          : output,
    ),
  };
  expect(await service.sign(request(walletPsbt(wrongFees), "mint-buy"))).toMatchObject({
    ok: false,
  });
  expect(sign).toHaveBeenCalledTimes(count);
  const wrongSuccessor = {
    ...plan,
    outputs: plan.outputs.map((output, index) =>
      index === 2
        ? { ...output, sats: output.sats + 1n }
        : index === plan.outputs.length - 1
          ? { ...output, sats: output.sats - 1n }
          : output,
    ),
  };
  expect(await service.sign(request(walletPsbt(wrongSuccessor), "mint-buy"))).toMatchObject({
    ok: false,
  });
  expect(sign).toHaveBeenCalledTimes(count);
  const staleService = new CrcGuardianSigningService({
    db: database.db,
    core: {
      ...provider,
      getTxout: async (txid, vout, include) =>
        core.outpoint({ txid, vout }) === core.outpoint(ledger.assets[deployId]!.vault)
          ? null
          : provider.getTxout(txid, vout, include),
    },
    custodyBackend: backend,
    guardianXOnly: await backend.xOnlyPubkey(),
    recoveryProfile,
    network: "regtest",
    protocolScript: Buffer.from(protocolScript, "hex"),
    maxMinerFeeSats: 20000n,
  });
  expect(await staleService.sign(request(walletPsbt(plan), "mint-buy"))).toMatchObject({
    ok: false,
  });
  expect(sign).toHaveBeenCalledTimes(count);
  const badRecovery = new CrcGuardianSigningService({
    db: database.db,
    core: provider,
    custodyBackend: backend,
    guardianXOnly: await backend.xOnlyPubkey(),
    recoveryProfile: dev1RecoveryProfile(
      Buffer.from(config.guardianCustody!.guardianPublicKeyHex, "hex"),
    ),
    network: "regtest",
    protocolScript: Buffer.from(protocolScript, "hex"),
    maxMinerFeeSats: 20000n,
  });
  expect(await badRecovery.sign(request(walletPsbt(plan), "mint-buy"))).toMatchObject({
    ok: false,
  });
  expect(sign).toHaveBeenCalledTimes(count);
  const forgedRequest = { ...request(walletPsbt(plan), "mint-buy"), state: { issuedAtoms: "0" } };
  expect(await service.sign(forgedRequest)).toMatchObject({ ok: false });
  expect(sign).toHaveBeenCalledTimes(count);
}, 60000);

test("actual custody spend reorg restores inventory and safely reuses the same verified journal", async () => {
  const before = await sync();
  node.rpc("invalidateblock", [lastBuy.blockHash]);
  node.clearOrphanMempool();
  const restored = await sync();
  expect(restored.assets[deployId]!.inventoryAtoms).toBe(100000000000n);
  const count = sign.mock.calls.length;
  const replayed = await service.sign(lastBuy.request);
  expect(replayed).toMatchObject({ ok: true });
  expect(sign).toHaveBeenCalledTimes(count);
  if (!replayed.ok) throw new Error(replayed.detail);
  const transaction = guardianPsbtTransaction(bitcoin.Psbt.fromBase64(replayed.signedPsbtBase64));
  expect(transaction.rawHex).toBe(lastBuy.rawHex);
  expect(node.accepted(transaction.rawHex).allowed).toBe(true);
  node.broadcast(transaction.rawHex);
  node.rpc("generatetoaddress", [1, node.rpc("getnewaddress", [], "bob")]);
  const after = await sync();
  expect(after.assets).toEqual(before.assets);
  expect(after.allocations).toEqual(before.allocations);
}, 60000);
test("state changes during custody signing reject the response and release the journal for a verified retry", async () => {
  const ledger = await sync();
  const plan = core.buildMint({
    state: ledger.assets[deployId]!,
    funding: [node.funding("alice")],
    amountAtoms: 100000000000n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const psbt = walletPsbt(plan);
  sign.mockImplementationOnce(async (params) => {
    node.mine();
    await sync();
    return TestGuardianCustodyBackend.prototype.signTaprootScriptPath.call(backend, params);
  });
  const rejected = await service.sign(request(psbt, "mint-buy"));
  expect(rejected).toMatchObject({ ok: false, detail: expect.stringMatching(/state changed/) });
  const rows = await database.pool.query("select status from crc_signatures where status='failed'");
  expect(rows.rows).toHaveLength(1);
  const retried = await service.sign(request(psbt, "mint-buy"));
  expect(retried).toMatchObject({ ok: true });
  if (!retried.ok) throw new Error(retried.detail);
  const transaction = guardianPsbtTransaction(bitcoin.Psbt.fromBase64(retried.signedPsbtBase64));
  expect(node.accepted(transaction.rawHex).allowed).toBe(true);
  node.broadcast(transaction.rawHex);
  node.mine();
  const after = await sync();
  expect(after.assets[deployId]!.issuedAtoms).toBe(200000000000n);
}, 60000);
