import { beforeAll, afterAll, test, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@crclaunch/crc20-protocol";
import {
  Core,
  aliceScript,
  aliceKey,
  bobScript,
  bobAddress,
  protocolScript,
} from "../../../cove-market/crc20-protocol/test-support/core.js";
import { authorizeOffer } from "../../../cove-market/crc20-protocol/test-support/signing.js";
import { isolatedDatabase } from "./test-support/database.js";
import * as store from "./store.js";
import { syncCrcTip } from "./runner.js";
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: aliceScript,
  creatorScriptHex: bobScript,
  protocolScriptHex: protocolScript,
};
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
const node = new Core();
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
};
const evidence: Record<string, unknown> = {};
let activationHeight: number;
const sync = () =>
  syncCrcTip({
    db: fixture.db,
    provider,
    network: "regtest",
    activationHeight,
    protocolScriptHex: protocolScript,
    persistence: { undoLimit: 2, checkpointInterval: 1, checkpointLimit: 3 },
  });
beforeAll(async () => {
  fixture = await isolatedDatabase();
  node.start();
  evidence.config = config;
  activationHeight = node.rpc("getblockcount") + 1;
  await store.initializeCrcLedger(fixture.db, config, { activationHeight });
}, 60000);
afterAll(async () => {
  if (process.env.CRC_INDEXER_EVIDENCE_DIR) {
    const directory = resolve(process.env.CRC_INDEXER_EVIDENCE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, "mined-indexer.json"),
      JSON.stringify(core.encodeProtocolDto(evidence), null, 2) + "\n",
    );
  }
  node.stop();
  if (fixture) await fixture.close();
}, 30000);
test("actual mined deploy/mint and offer retirement persist exact core state across restart/reorg", async () => {
  const deploy = core.buildDeploy({
    config,
    funding: [node.funding("alice")],
    changeScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const raw = node.sign(deploy);
  expect(node.accepted(raw).allowed).toBe(true);
  const deployId = await store.saveCrcRegistration(fixture.db, config, {
    rawHex: raw,
    prevouts: deploy.inputs,
  });
  expect(await store.loadCrcRegistrations(fixture.db, "regtest")).toEqual({ [deployId]: config });
  evidence.deploy = { plan: deploy, rawHex: raw, txid: deployId };
  node.broadcast(raw);
  node.mine();
  const beforeDeploy = await store.loadCrcCoreLedger(fixture.db, "regtest");
  await expect(
    syncCrcTip({
      db: fixture.db,
      provider: {
        ...provider,
        getRawTransaction: async () => {
          throw new Error("injected parent failure");
        },
      },
      network: "regtest",
      activationHeight,
      protocolScriptHex: protocolScript,
    }),
  ).rejects.toThrow(/parent failure/);
  expect(await store.loadCrcCoreLedger(fixture.db, "regtest")).toEqual(beforeDeploy);
  await fixture.pool.query(
    "CREATE FUNCTION crc_fail_real_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cursor failure'; END; $$",
  );
  await fixture.pool.query(
    "CREATE TRIGGER crc_fail_real BEFORE UPDATE ON crc_cursors FOR EACH ROW EXECUTE FUNCTION crc_fail_real_write()",
  );
  try {
    await expect(sync()).rejects.toThrow(/injected cursor failure/);
  } finally {
    await fixture.pool.query("DROP TRIGGER crc_fail_real ON crc_cursors");
    await fixture.pool.query("DROP FUNCTION crc_fail_real_write()");
  }
  expect(await store.loadCrcCoreLedger(fixture.db, "regtest")).toEqual(beforeDeploy);
  const deployed = (await sync()).snapshot.state!;
  const journalDigest = "ab".repeat(32);
  const journalContext = {
    network: "regtest",
    deployTxid: deployId,
    unsignedDigest: journalDigest,
    stateRoot: store.crcCoreStateRoot(deployed),
  };
  const claim = await store.claimCrcSignature(fixture.db, journalContext);
  expect(claim.claimId).toBeTruthy();
  await expect(store.claimCrcSignature(fixture.db, journalContext)).rejects.toThrow(/progress/);
  await store.releaseCrcSignature(fixture.db, claim.claimId);
  const retry = await store.claimCrcSignature(fixture.db, journalContext);
  expect(retry.claimId).not.toBe(claim.claimId);
  await expect(
    store.completeCrcSignature(fixture.db, claim.claimId, journalContext, "stale-claim"),
  ).rejects.toThrow();
  await store.completeCrcSignature(fixture.db, retry.claimId, journalContext, "signed-test-record");
  expect((await store.claimCrcSignature(fixture.db, journalContext)).signedPsbtBase64).toBe(
    "signed-test-record",
  );
  await expect(
    store.claimCrcSignature(fixture.db, { ...journalContext, stateRoot: "cd".repeat(32) }),
  ).rejects.toThrow(/changed/);
  const mint = core.buildMint({
    state: deployed.assets[deployId]!,
    funding: [node.funding("alice")],
    amountAtoms: 10000000000n,
    recipientScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const mintRaw = node.sign(mint);
  expect(node.accepted(mintRaw).allowed).toBe(true);
  expect(
    core.validateFinalTransaction(mint, { rawHex: mintRaw, prevouts: mint.inputs }, deployed),
  ).toBe(core.parseRawTransaction(mintRaw).txid);
  evidence.mint = { plan: mint, rawHex: mintRaw };
  const mintId = node.broadcast(mintRaw);
  node.mine();
  const minted = (await sync()).snapshot.state!;
  const listedInput = { txid: mintId, vout: 1, ...minted.allocations[`${mintId}:1`]! };
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: deployId,
      ticker: "TEST",
      listedInput,
      sellerScriptHex: aliceScript,
      priceSats: 10000n,
      expiryHeight: activationHeight + 100,
    },
    aliceKey.privateKey!,
  );
  await store.saveCrcOfferAuthorization(fixture.db, offer);
  const authorized = (await store.loadCrcCoreLedger(fixture.db, "regtest"))!;
  expect(authorized).toEqual(await core.registerOffer(minted, offer));
  await expect(
    store.saveCrcOfferAuthorization(fixture.db, { ...offer, priceSats: 20000n }),
  ).rejects.toThrow();
  const burn = node.sign({
    inputs: [listedInput],
    outputs: [{ scriptHex: bobScript, sats: 500n }],
  });
  expect(node.accepted(burn).allowed).toBe(true);
  const burnId = node.broadcast(burn);
  const burnHash = node.mine()[0];
  const burned = (await sync()).snapshot.state!;
  evidence.burn = {
    rawHex: burn,
    txid: burnId,
    hash: burnHash,
    stateRoot: store.crcCoreStateRoot(burned),
  };
  const actual = node.block(burnHash);
  // Add the coinbase too: observation and replay consume all block transactions.
  const coinbaseRaw = node.rpc("getrawtransaction", [
    node.rpc("getblock", [burnHash, 1]).tx[0],
    false,
    burnHash,
  ]);
  const expected = core.applyConfirmedBlock(
    authorized,
    {
      ...actual,
      transactions: [
        { rawHex: coinbaseRaw, prevouts: [] },
        ...actual.transactions.map((transaction: core.ChainTransaction) => ({
          ...transaction,
          parentRawTransactions: Object.fromEntries(
            transaction.prevouts.map((input) => [
              input.txid,
              node.rpc("getrawtransaction", [input.txid]),
            ]),
          ),
        })),
      ],
    },
    { undoLimit: 2, authorizations: [offer] },
  );
  expect(burned).toEqual(expected);
  expect(burned.assets[deployId]!.burnedAtoms).toBe(listedInput.atoms);
  expect(burned.offers[core.offerId(offer)]!.status).toBe("cancelled");
  expect(await store.loadCrcCoreLedger(fixture.db, "regtest")).toEqual(burned);
  node.rpc("invalidateblock", [burnHash]);
  node.clearOrphanMempool();
  node.rpc("generatetoaddress", [1, bobAddress]);
  const shallow = await sync();
  expect(shallow.rolledBack).toBe(1);
  expect(shallow.indexed).toBe(1);
  const restored = shallow.snapshot.state!;
  expect(restored.tip!.height).toBe(burned.tip!.height);
  expect(restored.tip!.hash).not.toBe(burnHash);
  evidence.sameHeightReorg = {
    oldHash: burnHash,
    newHash: restored.tip!.hash,
    height: restored.tip!.height,
  };
  expect(restored.allocations).toEqual(authorized.allocations);
  expect(restored.assets).toEqual(authorized.assets);
  expect(restored.offers).toEqual(authorized.offers);
  expect(node.rpc("getrawmempool")).not.toContain(burnId);
  await store.requestCrcOfferCancellation(fixture.db, "regtest", core.offerId(offer));
  expect(
    (await store.loadCrcCoreLedger(fixture.db, "regtest"))!.offers[core.offerId(offer)]!.status,
  ).toBe("cancelPending");
}, 60000);
test("deep actual reorg uses canonical checkpoint and replays when bounded undo is exhausted", async () => {
  node.mine(5);
  const before = (await sync()).snapshot.state!;
  expect(Object.keys(before.history)).toHaveLength(2);
  const forkHeight = activationHeight + 2;
  node.rpc("invalidateblock", [node.rpc("getblockhash", [forkHeight])]);
  node.clearOrphanMempool();
  node.rpc("generatetoaddress", [6, node.rpc("getnewaddress", [], "bob")]);
  const result = await sync();
  expect(result.rolledBack).toBeGreaterThan(0);
  expect(result.indexed).toBeGreaterThan(0);
  evidence.deepReorg = {
    indexed: result.indexed,
    rolledBack: result.rolledBack,
    tip: result.snapshot.state!.tip,
  };
  const persisted = (await store.loadCrcCoreLedger(fixture.db, "regtest"))!;
  expect(persisted.tip!.hash).toBe(node.rpc("getbestblockhash"));
  expect(Object.values(persisted.allocations)).toEqual(Object.values(before.allocations));
  expect(Object.values(persisted.offers)[0]!.status).toBe("cancelPending");
}, 60000);
test("actual cancelled-offer paid fill and unregistered external deployment follow only core decisions", async () => {
  const before = (await store.loadCrcCoreLedger(fixture.db, "regtest"))!;
  const offer = Object.values(before.offers)[0]!;
  const plan = core.buildPurchase({
    listedInput: offer.listedInput,
    priceSats: offer.priceSats,
    sellerScriptHex: offer.sellerScriptHex,
    ticker: offer.ticker,
    buyerFunding: [node.funding("bob")],
    buyerScriptHex: bobScript,
    protocolScriptHex: protocolScript,
    minerFeeSats: 1000n,
  });
  const raw = node.sign({ ...plan, inputWitnesses: [offer.sellerWitnessHex] }, ["bob"]);
  expect(
    core.validateFinalTransaction(
      { ...plan, inputWitnesses: [offer.sellerWitnessHex] },
      { rawHex: raw, prevouts: plan.inputs },
      before,
    ),
  ).toBe(core.parseRawTransaction(raw).txid);
  expect(node.accepted(raw).allowed).toBe(true);
  node.broadcast(raw);
  node.mine();
  const filled = (await sync()).snapshot.state!;
  evidence.fill = { plan, rawHex: raw, offer, stateRoot: store.crcCoreStateRoot(filled) };
  expect(filled.offers[core.offerId(offer)]!.status).toBe("filled");
  expect(Object.values(filled.allocations)).toEqual([
    expect.objectContaining({ scriptHex: bobScript, atoms: offer.listedInput.atoms }),
  ]);
  expect(filled.assets[offer.deployTxid]!.burnedAtoms).toBe(0n);
  const externalPlan = core.buildDeploy({
    config: { ...config, ticker: "EXTERNAL" },
    funding: [node.funding("alice")],
    changeScriptHex: aliceScript,
    minerFeeSats: 1000n,
  });
  const externalRaw = node.sign(externalPlan);
  expect(node.accepted(externalRaw).allowed).toBe(true);
  const externalId = node.broadcast(externalRaw);
  node.mine();
  const after = (await sync()).snapshot.state!;
  expect(after.assets[externalId]).toBeUndefined();
  expect(after.assets).toEqual(filled.assets);
  expect(after.allocations).toEqual(filled.allocations);
  evidence.excludedDeployment = { txid: externalId, rawHex: externalRaw };
}, 60000);
