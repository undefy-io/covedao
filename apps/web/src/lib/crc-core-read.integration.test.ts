import {
  createCrcBuildSession,
  claimCrcBuildSession,
  markCrcBuildReady,
  releaseCrcBuildSession,
} from "./crc-session";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, test, expect } from "vitest";
import * as core from "@crclaunch/crc20-protocol";
import * as state from "@crclaunch/crc20-state";
import * as bitcoin from "bitcoinjs-lib";
import { saveWalletFundingSnapshot } from "@crclaunch/db";
import { dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { buildCrcLaunchSession, buildCrcTradeSession } from "./crc-build";
import { loadCrcFundingCandidates } from "./crc-funding";
import { aliceKey } from "../../../../packages/cove-market/crc20-protocol/test-support/core.js";
import { isolatedDatabase } from "../../../../packages/cove-indexer/src/crc20/test-support/database.js";
import {
  readCrcAsset,
  readCrcCursor,
  readCrcBalance,
  listCrcAssets,
  readCrcTokenUtxo,
  readCrcWalletBalances,
  readCrcActivity,
  readCrcTrades,
} from "./crc-read";
const saved = core.decodeProtocolDto<{
  config: core.Config;
  deploy: { plan: core.Plan; rawHex: string; txid: string };
  mint: { plan: core.Plan; rawHex: string };
}>(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../artifacts/crc-core-integration/indexer/mined-indexer.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
let database: Awaited<ReturnType<typeof isolatedDatabase>>;
beforeAll(async () => {
  database = await isolatedDatabase();
  await state.initializeCrcLedger(database.db, saved.config);
  await state.saveCrcRegistration(database.db, saved.config, {
    rawHex: saved.deploy.rawHex,
    prevouts: saved.deploy.plan.inputs,
  });
  const registrations = { [saved.deploy.txid]: saved.config };
  await state.persistCrcCoreBlock(
    database.db,
    "regtest",
    {
      hash: "11".repeat(32),
      parentHash: "00".repeat(32),
      height: 1,
      timestamp: 1700000000,
      transactions: [{ rawHex: saved.deploy.rawHex, prevouts: saved.deploy.plan.inputs }],
    },
    registrations,
  );
  await state.persistCrcCoreBlock(
    database.db,
    "regtest",
    {
      hash: "22".repeat(32),
      parentHash: "11".repeat(32),
      height: 2,
      timestamp: 1700000600,
      transactions: [{ rawHex: saved.mint.rawHex, prevouts: saved.mint.plan.inputs }],
    },
    registrations,
  );
}, 30000);
afterAll(async () => {
  if (database) await database.close();
});
test("API reads use only fresh core state and preserve the interface's asset/balance mappings", async () => {
  const asset = await readCrcAsset(database.db, "regtest", saved.deploy.txid);
  expect(asset).toMatchObject({
    assetId: `regtest:${saved.deploy.txid}`,
    mintedAtoms: "10000000000",
    circulatingAtoms: "10000000000",
    inventoryAtoms: "0",
    deployHeight: "1",
    deployBlockHash: "11".repeat(32),
    metadata: { displayName: "TEST" },
    availability: "active",
  });
  expect(await listCrcAssets(database.db, "regtest", 10)).toHaveLength(1);
  expect(await readCrcAsset(database.db, "signet", saved.deploy.txid)).toBeNull();
  expect(await readCrcCursor(database.db, "regtest")).toEqual({
    height: "2",
    blockHash: "22".repeat(32),
  });
  const mintId = core.parseRawTransaction(saved.mint.rawHex).txid;
  const owner = saved.mint.plan.outputs[1]!.scriptHex;
  expect(
    await readCrcTokenUtxo(database.db, "regtest", saved.deploy.txid, mintId, 1),
  ).toMatchObject({ scriptHex: owner, atoms: 10000000000n });
  expect(await readCrcBalance(database.db, "regtest", saved.deploy.txid, owner)).toBe(10000000000n);
  expect(await readCrcWalletBalances(database.db, "regtest", owner, 10)).toEqual([
    { assetId: `regtest:${saved.deploy.txid}`, ticker: "TEST", atoms: "10000000000" },
  ]);
  expect(await readCrcActivity(database.db, "regtest", saved.deploy.txid)).toHaveLength(2);
  expect(await readCrcTrades(database.db, "regtest", saved.deploy.txid)).toMatchObject([
    { side: "buy", amountAtoms: "10000000000", totalPriceSats: "3" },
  ]);
  await state.rollbackCrcCoreTip(database.db, "regtest");
  expect(await readCrcBalance(database.db, "regtest", saved.deploy.txid, owner)).toBe(0n);
  expect(await readCrcTrades(database.db, "regtest", saved.deploy.txid)).toEqual([]);
});
test("launch builds persist the exact shared-core plan in fresh sessions and keep idempotent custody", async () => {
  const funding = { txid: "cc".repeat(32), vout: 0 };
  const script = saved.config.vaultScriptHex;
  await saveWalletFundingSnapshot(database.db, "regtest", script, [
    { ...funding, valueSats: "12000", confirmations: 1 },
  ]);
  const params = {
    db: database.db,
    network: "regtest" as const,
    bitcoinNetwork: bitcoin.networks.regtest,
    ticker: "NEW",
    walletScriptHex: script,
    tokenScriptHex: script,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    funding: [funding],
    minerFeeSats: 1000,
    idempotencyKey: "fresh-launch",
    feeScriptHex: saved.config.protocolScriptHex,
    guardianXOnly: Buffer.from(aliceKey.publicKey).subarray(1),
    recoveryProfile: dev1RecoveryProfile(
      Buffer.from("24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c", "hex"),
    ),
  };
  const built = await buildCrcLaunchSession(params);
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  expect(psbt.txOutputs.map((output) => output.value)).toEqual([0, 1000, 1000, 7000, 2000]);
  const row = (
    await database.pool.query("select * from crc_sessions where id=$1", [built.sessionId])
  ).rows[0];
  expect(row.trusted_json.corePlan).toBeDefined();
  expect(row.trusted_json.coreConfig.guardianCustody).toBeDefined();
  const plan = core.decodeProtocolDto<core.Plan>(row.trusted_json.corePlan);
  expect(plan.outputs.map((output) => output.sats)).toEqual(
    psbt.txOutputs.map((output) => BigInt(output.value)),
  );
  expect(await buildCrcLaunchSession(params)).toEqual(built);
  await saveWalletFundingSnapshot(database.db, "regtest", script, []);
  expect(await buildCrcLaunchSession(params)).toEqual(built);
}, 30000);
test("funding excludes indexed token carriers and vaults with or without wallet metadata", async () => {
  await state.persistCrcCoreBlock(
    database.db,
    "regtest",
    {
      hash: "22".repeat(32),
      parentHash: "11".repeat(32),
      height: 2,
      timestamp: 1700000600,
      transactions: [{ rawHex: saved.mint.rawHex, prevouts: saved.mint.plan.inputs }],
    },
    { [saved.deploy.txid]: saved.config },
  );
  const ledger = (await state.loadCrcCoreLedger(database.db, "regtest"))!;
  const vault = ledger.assets[saved.deploy.txid]!.vault;
  const carrier = core.parseRawTransaction(saved.mint.rawHex).txid;
  const ordinary = { txid: "cc".repeat(32), vout: 0 };
  const pending = { txid: "dd".repeat(32), vout: 0 };
  const script = saved.config.vaultScriptHex;
  await saveWalletFundingSnapshot(database.db, "regtest", script, [
    { txid: carrier, vout: 1, valueSats: "1000", confirmations: 1 },
    {
      txid: vault.txid,
      vout: vault.vout,
      valueSats: core.sats(vault.sats).toString(),
      confirmations: 1,
    },
    { ...ordinary, valueSats: "20000", confirmations: 1 },
    { ...pending, valueSats: "30000", confirmations: 0 },
  ]);
  const candidates = [
    { txid: carrier, vout: 1 },
    { txid: vault.txid, vout: vault.vout },
    ordinary,
    pending,
  ];
  for (const metadata of [undefined, Buffer.from(aliceKey.publicKey).toString("hex")]) {
    expect(
      await loadCrcFundingCandidates(database.db, "regtest", script, candidates, {
        allowCarrier: true,
        publicKeyHex: metadata,
      }),
    ).toEqual([
      {
        ...ordinary,
        sats: 20000n,
        scriptHex: script,
        ...(metadata ? { publicKeyHex: metadata } : {}),
      },
    ]);
  }
  await expect(
    loadCrcFundingCandidates(database.db, "regtest", script, [ordinary, ordinary]),
  ).rejects.toThrow(/duplicate/);
  await expect(
    loadCrcFundingCandidates(database.db, "regtest", script, [{ ...ordinary, vout: 9 }]),
  ).rejects.toThrow(/observed/);
}, 30000);

test("expired API signing leases cannot complete or release a newer claim", async () => {
  const session = await createCrcBuildSession(database.db, {
    network: "regtest",
    operation: "deploy",
    deploymentTxid: null,
    idempotencyKey: "lease-fence",
    requestHash: "aa".repeat(32),
    unsignedTxDigest: "bb".repeat(32),
    psbtBase64: "opaque-test-record",
    walletScriptHex: saved.config.vaultScriptHex,
    tokenScriptHex: saved.config.vaultScriptHex,
    trustedJson: {},
  });
  const first = (await claimCrcBuildSession(database.db, "regtest", session.id, "cc".repeat(32)))!;
  expect(
    await claimCrcBuildSession(database.db, "regtest", session.id, "ee".repeat(32)),
  ).toBeNull();
  await database.pool.query(
    "update crc_sessions set claimed_at=clock_timestamp()-interval '31 seconds' where id=$1",
    [session.id],
  );
  const second = (await claimCrcBuildSession(database.db, "regtest", session.id, "ee".repeat(32)))!;
  expect(second.claimId).not.toBe(first.claimId);
  await expect(
    markCrcBuildReady(database.db, "regtest", session.id, "00", "dd".repeat(32), first.claimId!),
  ).rejects.toThrow();
  await releaseCrcBuildSession(database.db, "regtest", session.id, first.claimId!);
  expect(
    (
      await database.pool.query("select status,claim_id from crc_sessions where id=$1", [
        session.id,
      ])
    ).rows[0],
  ).toEqual({ status: "SIGNING", claim_id: second.claimId });
  await markCrcBuildReady(
    database.db,
    "regtest",
    session.id,
    "00",
    "dd".repeat(32),
    second.claimId!,
  );
});

test("fresh CRC vault lookup has a bounded network and vault txid index", async () => {
  const rows = (
    await database.pool.query(
      "select indexdef from pg_indexes where indexname='crc_records_vault_idx'",
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].indexdef).toMatch(/network.*value_json.*vault.*txid/);
  expect(rows[0].indexdef).toMatch(/WHERE.*kind.*assets/);
});

test("new curve builds map core quantum refusal to a client amount error", async () => {
  const ledger = (await state.loadCrcCoreLedger(database.db, "regtest"))!;
  const tokens = Object.keys(ledger.allocations).map((key) => ({
    txid: key.split(":")[0]!,
    vout: Number(key.split(":")[1]),
  }));
  await expect(
    buildCrcTradeSession({
      db: database.db,
      network: "regtest",
      bitcoinNetwork: bitcoin.networks.regtest,
      asset: { assetId: `regtest:${saved.deploy.txid}`, deployTxid: saved.deploy.txid },
      operation: "sell",
      amountAtoms: 1n,
      walletScriptHex: saved.config.vaultScriptHex,
      tokenScriptHex: saved.config.vaultScriptHex,
      walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
      tokenPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
      sellerFunding: tokens,
      paymentFunding: [],
      minerFeeSats: 1000,
      idempotencyKey: "invalid-small-sale",
      feeScriptHex: saved.config.protocolScriptHex,
    }),
  ).rejects.toMatchObject({ code: "TOKEN_AMOUNT_INVALID" });
});
