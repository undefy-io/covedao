import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { saveFeeObservation } from "@crclaunch/cove-app";
import { crcTradeBuildRoute } from "./crc-trade-build-route";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, test, expect, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "@crclaunch/crc20-protocol";
import * as state from "@crclaunch/crc20-state";
import { createPlanPsbt, guardianPsbtTransaction } from "@crclaunch/crc20-adapters";
import { saveWalletFundingSnapshot } from "@crclaunch/db";
import { dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { isolatedDatabase } from "../../../../packages/cove-indexer/src/crc20/test-support/database.js";
import {
  Core,
  aliceKey,
  aliceScript,
  aliceAddress,
  bobScript,
  bobKey,
  protocolScript,
} from "../../../../packages/cove-market/crc20-protocol/test-support/core.js";
import { TestGuardianCustodyBackend } from "../../../../packages/cove-guardian/src/v3/custody.js";
import { CrcGuardianSigningService } from "../../../../packages/crc20-guardian/src/index.js";
import { syncCrcTip } from "@crclaunch/cove-indexer/crc20";
import { buildCrcLaunchSession, buildCrcTradeSession, buildCrcOfferSession } from "./crc-build";
import { crcMarketPost } from "./crc-market-route";
import { activateCrcCoreOffer } from "./crc-market-core";
import { authorizeOffer } from "../../../../packages/cove-market/crc20-protocol/test-support/signing.js";
import { readCrcQuoteAsset } from "./crc-read";
const injected = vi.hoisted(() => ({ services: {} as any }));
vi.mock("./crc-mutation", () => ({ getCrcMutationServices: () => injected.services }));
vi.mock("./crc-rate-limit", () => ({ checkCrcRateLimit: () => null }));
import { crcSubmitRoute } from "./crc-submit-route";
let database: Awaited<ReturnType<typeof isolatedDatabase>>,
  server: Server,
  endpoint: string,
  service: CrcGuardianSigningService,
  deployId: string,
  activationHeight: number;
let dropNextGuardianResponse = false,
  failNextBroadcast = false;
const minedEvidence: unknown[] = [];
const node = new Core(),
  backend = new TestGuardianCustodyBackend(Buffer.alloc(32, 0x41));
const recoveryProfile = dev1RecoveryProfile(Buffer.from(aliceKey.publicKey).subarray(1));
const sign = vi.spyOn(backend, "signTaprootScriptPath");
const provider = {
  async getBlockchainInfo() {
    const info = node.rpc("getblockchaininfo");
    return { chain: info.chain, blocks: info.blocks, bestBlockHash: info.bestblockhash };
  },
  async getBlockHash(height: number) {
    return node.rpc("getblockhash", [height]);
  },
  async getBlock(hash: string) {
    const b = node.rpc("getblock", [hash, 1]);
    return {
      hash,
      height: b.height,
      previousBlockHash: b.previousblockhash,
      timestamp: b.time,
      txids: b.tx,
      rawTxs: b.tx.map((id: string) => node.rpc("getrawtransaction", [id, false, hash])),
    };
  },
  async getRawTransaction(id: string) {
    return node.rpc("getrawtransaction", [id]);
  },
  async getTxout(id: string, vout: number, include = true) {
    const o = node.rpc("gettxout", [id, vout, include]);
    return o
      ? {
          scriptPubKeyHex: o.scriptPubKey.hex,
          valueSats: BigInt(Math.round(o.value * 1e8)),
          confirmations: o.confirmations,
        }
      : null;
  },
  async testMempoolAccept(raw: string) {
    return node.accepted(raw);
  },
  async broadcastTransaction(raw: string) {
    const id = core.parseRawTransaction(raw).txid;
    if (!deployId) {
      const registrations = await state.loadCrcRegistrations(database.db, "regtest");
      expect(registrations[id]).toBeDefined();
    }
    if (failNextBroadcast) {
      failNextBroadcast = false;
      throw new Error("isolated broadcast transport failure");
    }
    const broadcast = node.broadcast(raw);
    const rows = (
      await database.pool.query("select operation, trusted_json from crc_sessions where txid=$1", [
        broadcast,
      ])
    ).rows;
    minedEvidence.push({
      txid: broadcast,
      rawHex: raw,
      actual: core.encodeProtocolDto(node.transaction(broadcast)),
      session: rows[0],
    });
    return broadcast;
  },
  async observeTransaction(id: string) {
    if (node.rpc("getrawmempool").includes(id)) return { state: "mempool" };
    try {
      const t = node.rpc("getrawtransaction", [id, true]);
      return { state: t.confirmations > 0 ? "mined" : "unknown" };
    } catch (error) {
      if (String((error as { stderr?: unknown }).stderr).includes("code: -5"))
        return { state: "unknown" };
      throw error;
    }
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
async function cacheFunding(wallet: "alice" | "bob" = "alice") {
  const input = node.funding(wallet);
  await saveWalletFundingSnapshot(
    database.db,
    "regtest",
    wallet === "alice" ? aliceScript : bobScript,
    [
      {
        txid: input.txid,
        vout: input.vout,
        valueSats: core.sats(input.sats).toString(),
        confirmations: 1,
      },
    ],
  );
  return [{ txid: input.txid, vout: input.vout }];
}
function walletSign(psbtBase64: string, guardian = false, entropy?: number, key = aliceKey) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  for (let index = guardian ? 1 : 0; index < psbt.inputCount; index++)
    psbt.signInput(
      index,
      entropy === undefined
        ? key
        : {
            publicKey: aliceKey.publicKey,
            sign: (hash: Buffer) =>
              Buffer.from(ecc.sign(hash, aliceKey.privateKey!, Buffer.alloc(32, entropy))),
          },
    );
  return psbt.toBase64();
}
async function submit(
  sessionId: string,
  signedPsbtBase64: string,
  operation: "deploy" | "buy" | "sell" | "transfer" | "listing" | "purchase" | "cancel",
) {
  const response = await crcSubmitRoute(
    new Request("http://localhost/api/crc/v1/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, signedPsbtBase64 }),
    }),
    operation,
  );
  const body = await response.json();
  expect(body, JSON.stringify(body)).toMatchObject({ ok: true, data: { status: "BROADCAST" } });
  return body.data as { txid: string; status: string };
}
beforeAll(async () => {
  database = await isolatedDatabase();
  node.start();
  activationHeight = node.rpc("getblockcount") + 1;
  server = createServer(async (req, res) => {
    if (req.url !== "/sign/crc20" || req.headers.authorization !== "Bearer isolated") {
      res.writeHead(401);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const result = await service.sign(JSON.parse(Buffer.concat(chunks).toString()));
      if (dropNextGuardianResponse && result.ok) {
        dropNextGuardianResponse = false;
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, detail: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  injected.services = {
    db: database.db,
    config: { network: "regtest" },
    provider,
    crcVaultConfig: {
      feeScriptHex: protocolScript,
      guardianXOnly: await backend.xOnlyPubkey(),
      recoveryProfile,
    },
    guardianEndpoint: endpoint,
    guardianAuthToken: "isolated",
  };
}, 60000);
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (process.env.CRC_CORE_API_EVIDENCE_PATH)
    writeFileSync(
      process.env.CRC_CORE_API_EVIDENCE_PATH,
      JSON.stringify({ network: "regtest", transactions: minedEvidence }, null, 2) + "\n",
    );
  node.stop();
  if (database) await database.close();
}, 30000);
test("HTTP submit registers exact signed core deployment before actual broadcast and is idempotent", async () => {
  const built = await buildCrcLaunchSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    ticker: "TEST",
    metadata: { displayName: "Core coin", description: "Owned regtest only" },
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    funding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "http-deploy",
    feeScriptHex: protocolScript,
    guardianXOnly: await backend.xOnlyPubkey(),
    recoveryProfile,
  });
  const config = core.decodeProtocolDto<core.Config>(built.intent.coreConfig);
  await state.initializeCrcLedger(database.db, config, { activationHeight });
  const signed = walletSign(built.psbtBase64);
  const first = await submit(built.sessionId, signed, "deploy");
  deployId = first.txid;
  expect(await submit(built.sessionId, signed, "deploy")).toEqual(first);
  node.mine();
  const ledger = await sync();
  expect(ledger.assets[deployId]).toBeDefined();
  const metadata = (
    await database.pool.query("select display_name from crc_metadata where deploy_txid=$1", [
      deployId,
    ])
  ).rows;
  expect(metadata).toEqual([{ display_name: "Core coin" }]);
  service = new CrcGuardianSigningService({
    db: database.db,
    core: provider,
    custodyBackend: backend,
    guardianXOnly: await backend.xOnlyPubkey(),
    recoveryProfile,
    network: "regtest",
    protocolScript: Buffer.from(protocolScript, "hex"),
    maxMinerFeeSats: 20000n,
  });
}, 60000);
test("HTTP API sends verified wallet first to actual shared Guardian and mines indexed core mint", async () => {
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const built = await buildCrcTradeSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    asset,
    operation: "buy",
    amountAtoms: 100000000000n,
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "http-mint",
    feeScriptHex: protocolScript,
  });
  const signed = walletSign(built.psbtBase64, true);
  const first = await submit(built.sessionId, signed, "buy");
  expect(sign).toHaveBeenCalledOnce();
  expect(await submit(built.sessionId, signed, "buy")).toEqual(first);
  expect(sign).toHaveBeenCalledOnce();
  node.mine();
  const ledger = await sync();
  expect(ledger.assets[deployId]!.issuedAtoms).toBe(100000000000n);
  expect(ledger.allocations[`${first.txid}:1`]!.atoms).toBe(100000000000n);
}, 60000);
test("HTTP sell and inventory buy mine exact core plans, fees and allocations", async () => {
  for (const operation of ["sell", "buy"] as const) {
    const before = await sync();
    const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
    const tokens = Object.entries(before.allocations)
      .filter(
        ([, allocation]) =>
          allocation.deployTxid === deployId && allocation.scriptHex === aliceScript,
      )
      .map(([outpoint]) => ({
        txid: outpoint.split(":")[0]!,
        vout: Number(outpoint.split(":")[1]),
      }));
    const built = await buildCrcTradeSession({
      db: database.db,
      network: "regtest",
      bitcoinNetwork: bitcoin.networks.regtest,
      asset,
      operation,
      amountAtoms: 100000000000n,
      walletScriptHex: aliceScript,
      tokenScriptHex: aliceScript,
      walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
      tokenPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
      ...(operation === "sell" ? { sellerFunding: tokens } : {}),
      paymentFunding: await cacheFunding(),
      minerFeeSats: 1000,
      idempotencyKey: `http-${operation}-roundtrip`,
      feeScriptHex: protocolScript,
    });
    const signed = walletSign(built.psbtBase64, true);
    const expected = core.validateGuardianTransaction(
      before,
      guardianPsbtTransaction(bitcoin.Psbt.fromBase64(signed)),
    ).ledger;
    const result = await submit(built.sessionId, signed, operation);
    const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
    core.validateFinalTransaction(plan, node.transaction(result.txid), {
      ...before,
      config: before.assets[deployId]!.config,
    });
    expect(plan.minerFeeSats).toBe(1000n);
    node.mine();
    const indexed = await sync();
    expect(indexed.assets).toEqual(expected.assets);
    expect(indexed.allocations).toEqual(expected.allocations);
    expect(indexed.assets[deployId]!.inventoryAtoms).toBe(
      operation === "sell" ? 100000000000n : 0n,
    );
  }
}, 60000);
test("HTTP unsigned or changed wallet response never reaches Core live checks or custody", async () => {
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const built = await buildCrcTradeSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    asset,
    operation: "buy",
    amountAtoms: 100000000000n,
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "http-wallet-rejection",
    feeScriptHex: protocolScript,
  });
  const count = sign.mock.calls.length,
    rpcCount = node.calls.length;
  for (const responsePsbt of [
    built.psbtBase64,
    (() => {
      const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
      plan.outputs[1]!.scriptHex = "0014" + "11".repeat(20);
      const psbt = createPlanPsbt(plan, "regtest");
      return walletSign(psbt.toBase64(), true);
    })(),
  ]) {
    const response = await crcSubmitRoute(
      new Request("http://localhost/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: responsePsbt }),
      }),
      "buy",
    );
    expect((await response.json()).error.code).toBe("WALLET_SIGNATURE_INVALID");
  }
  expect(sign).toHaveBeenCalledTimes(count);
  expect(node.calls).toHaveLength(rpcCount);
}, 60000);

test("HTTP re-signed retry uses cached Guardian witness after lost response", async () => {
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const built = await buildCrcTradeSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    asset,
    operation: "buy",
    amountAtoms: 100000000000n,
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "http-lost-guardian",
    feeScriptHex: protocolScript,
  });
  const first = walletSign(built.psbtBase64, true, 1),
    retry = walletSign(built.psbtBase64, true, 2);
  expect(first).not.toBe(retry);
  const count = sign.mock.calls.length;
  dropNextGuardianResponse = true;
  const response = await crcSubmitRoute(
    new Request("http://localhost/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: first }),
    }),
    "buy",
  );
  expect((await response.json()).error.code).toBe("GUARDIAN_UNAVAILABLE");
  expect(sign).toHaveBeenCalledTimes(count + 1);
  const result = await submit(built.sessionId, retry, "buy");
  expect(sign).toHaveBeenCalledTimes(count + 1);
  const expectedWallet = bitcoin.Psbt.fromBase64(retry);
  for (let index = 1; index < expectedWallet.inputCount; index++)
    expectedWallet.finalizeInput(index);
  const transaction = core.parseRawTransaction(node.rpc("getrawtransaction", [result.txid]));
  expect(transaction.inputs[1]!.witness).toEqual(
    core.decodeWitness(expectedWallet.data.inputs[1]!.finalScriptWitness!.toString("hex")),
  );
  node.mine();
  expect((await sync()).allocations[`${result.txid}:1`]!.atoms).toBe(100000000000n);
}, 60000);

test("HTTP arbitrary transfer and one-transaction listing preserve exact core allocations", async () => {
  for (const operation of ["transfer", "listing"] as const) {
    const before = await sync();
    const tokenFunding = Object.entries(before.allocations)
      .filter(([, a]) => a.deployTxid === deployId && a.scriptHex === aliceScript)
      .map(([key]) => ({ txid: key.split(":")[0]!, vout: Number(key.split(":")[1]) }));
    const funding = await cacheFunding();
    const rpcCount = node.calls.length;
    const response = await crcMarketPost(
      new Request(`http://localhost/api/crc/v1/market/${operation}-build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deployTxid: deployId,
          amountAtoms: "1",
          recipientScriptHex: operation === "transfer" ? bobScript : aliceScript,
          priceSats: operation === "listing" ? "5000" : undefined,
          tokenFunding,
          paymentFunding: funding,
          walletScriptHex: aliceScript,
          tokenScriptHex: aliceScript,
          walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
          tokenPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
          minerFeeSats: 1000,
          idempotencyKey: `http-${operation}`,
        }),
      }),
      `${operation}-build`,
      true,
      () => ({
        db: database.db,
        network: "regtest",
        provider: provider as unknown as CoreRpcProvider,
        feeScriptHex: protocolScript,
      }),
    );
    expect(node.calls).toHaveLength(rpcCount);
    const body = await response.json();
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
    const built = body.data;
    const count = sign.mock.calls.length;
    const result = await submit(built.sessionId, walletSign(built.psbtBase64), operation);
    expect(sign).toHaveBeenCalledTimes(count);
    const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
    core.validateFinalTransaction(plan, node.transaction(result.txid), {
      ...before,
      config: before.assets[deployId]!.config,
    });
    node.mine();
    const after = await sync();
    expect(after.allocations[`${result.txid}:1`]).toMatchObject({
      atoms: 1n,
      scriptHex: operation === "transfer" ? bobScript : aliceScript,
    });
    expect(after.assets[deployId]).toEqual(before.assets[deployId]);
  }
}, 60000);

test("core offer activation and buyer-only API fill preserve seller presign and exact fees", async () => {
  const before = await sync();
  const [outpoint, allocation] = Object.entries(before.allocations).find(
    ([, a]) => a.deployTxid === deployId && a.scriptHex === aliceScript && a.atoms === 1n,
  )!;
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: deployId,
      ticker: "TEST",
      listedInput: {
        ...allocation,
        txid: outpoint.split(":")[0]!,
        vout: Number(outpoint.split(":")[1]),
      },
      sellerScriptHex: aliceScript,
      priceSats: 5000n,
      expiryHeight: before.tip!.height + 10,
    },
    aliceKey.privateKey!,
  );
  const response = await crcMarketPost(
    new Request("http://localhost/api/crc/v1/market/listings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: core.encodeProtocolDto(offer) }),
    }),
    "listings",
    true,
    () => ({
      db: database.db,
      network: "regtest",
      provider: provider as unknown as CoreRpcProvider,
    }),
  );
  const body = await response.json();
  expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
  const id = body.data.listingId as string;
  expect(
    await activateCrcCoreOffer({
      db: database.db,
      network: "regtest",
      provider,
      offer: core.encodeProtocolDto(offer),
    }),
  ).toBe(id);
  const rpcCount = node.calls.length;
  const funding = await cacheFunding("bob");
  const afterFunding = node.calls.length;
  const reserved = await crcMarketPost(
    new Request("http://localhost/api/crc/v1/market/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offerId: id,
        walletScriptHex: bobScript,
        tokenScriptHex: bobScript,
        walletPublicKeyHex: Buffer.from(bobKey.publicKey).toString("hex"),
        paymentFunding: funding,
        minerFeeSats: 1000,
        idempotencyKey: "http-presigned-purchase",
      }),
    }),
    "reserve",
    true,
    () => ({
      db: database.db,
      network: "regtest",
      provider: provider as unknown as CoreRpcProvider,
      feeScriptHex: protocolScript,
    }),
  );
  expect(node.calls).toHaveLength(afterFunding);
  expect(afterFunding).toBeGreaterThan(rpcCount);
  const reservedBody = await reserved.json();
  expect(reservedBody, JSON.stringify(reservedBody)).toMatchObject({ ok: true });
  const built = reservedBody.data;
  const count = sign.mock.calls.length;
  const completed = await crcMarketPost(
    new Request("http://localhost/api/crc/v1/market/buyer-sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: built.sessionId,
        signedPsbtBase64: walletSign(built.psbtBase64, true, undefined, bobKey),
      }),
    }),
    "buyer-sign",
    true,
    () => ({
      db: database.db,
      network: "regtest",
      provider: provider as unknown as CoreRpcProvider,
    }),
  );
  const completedBody = await completed.json();
  expect(completedBody, JSON.stringify(completedBody)).toMatchObject({ ok: true });
  const result = completedBody.data;
  expect(sign).toHaveBeenCalledTimes(count);
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  const transaction = node.transaction(result.txid);
  core.validateFinalTransaction(plan, transaction, {
    ...(await state.loadCrcCoreLedger(database.db, "regtest"))!,
    config: before.assets[deployId]!.config,
  });
  expect(
    core
      .parseRawTransaction(transaction.rawHex)
      .inputs[0]!.witness.map((w) => Buffer.from(w).toString("hex")),
  ).toEqual(offer.sellerWitnessHex);
  expect(plan.minerFeeSats).toBe(1000n);
  expect(plan.outputs.find((o) => o.role === "protocolFee")!.sats).toBe(core.marketFee(5000n));
  node.mine();
  const after = await sync();
  expect(after.allocations[`${result.txid}:2`]).toMatchObject({ atoms: 1n, scriptHex: bobScript });
  expect(after.offers[id]!.status).toBe("filled");
}, 60000);

test("API cancellation mines, rolls back with actual reorg, and rebroadcasts its persisted receipt", async () => {
  const before = await sync();
  const [outpoint, allocation] = Object.entries(before.allocations).find(
    ([, a]) => a.deployTxid === deployId && a.scriptHex === bobScript && a.atoms === 1n,
  )!;
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: deployId,
      ticker: "TEST",
      listedInput: {
        ...allocation,
        txid: outpoint.split(":")[0]!,
        vout: Number(outpoint.split(":")[1]),
      },
      sellerScriptHex: bobScript,
      priceSats: 5000n,
      expiryHeight: before.tip!.height + 10,
    },
    bobKey.privateKey!,
  );
  const id = await activateCrcCoreOffer({
    db: database.db,
    network: "regtest",
    provider,
    offer: core.encodeProtocolDto(offer),
  });
  const built = await buildCrcOfferSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    offerId: id,
    operation: "cancel",
    walletScriptHex: bobScript,
    tokenScriptHex: bobScript,
    walletPublicKeyHex: Buffer.from(bobKey.publicKey).toString("hex"),
    tokenPublicKeyHex: Buffer.from(bobKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding("bob"),
    minerFeeSats: 1000,
    idempotencyKey: "http-cancel",
    feeScriptHex: protocolScript,
  });
  const signed = walletSign(built.psbtBase64, false, undefined, bobKey);
  const result = await submit(built.sessionId, signed, "cancel");
  node.mine();
  const after = await sync();
  expect(after.offers[id]!.status).toBe("cancelled");
  expect(after.allocations[`${result.txid}:1`]).toMatchObject({ atoms: 1n, scriptHex: bobScript });
  const orphan = after.tip!.hash;
  node.rpc("invalidateblock", [orphan]);
  node.clearOrphanMempool();
  const restored = await sync();
  expect(restored.offers[id]!.status).toBe("open");
  expect(restored.allocations[outpoint]).toEqual(allocation);
  expect(restored.allocations[`${result.txid}:1`]).toBeUndefined();
  const events = await database.pool.query("select txid from crc_events where txid=$1", [
    result.txid,
  ]);
  expect(events.rows).toHaveLength(0);
  expect(await submit(built.sessionId, signed, "cancel")).toEqual(result);
  node.mine();
  expect((await sync()).offers[id]!.status).toBe("cancelled");
}, 60000);

test("HTTP forged offer terms and wrong network reject before live RPC or custody", async () => {
  const before = await sync();
  const [key, allocation] = Object.entries(before.allocations).find(
    ([, a]) => a.deployTxid === deployId && a.scriptHex === bobScript && a.atoms === 1n,
  )!;
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: deployId,
      ticker: "TEST",
      listedInput: { ...allocation, txid: key.split(":")[0]!, vout: Number(key.split(":")[1]) },
      sellerScriptHex: bobScript,
      priceSats: 5000n,
      expiryHeight: before.tip!.height + 10,
    },
    bobKey.privateKey!,
  );
  const rpcCount = node.calls.length,
    signCount = sign.mock.calls.length;
  for (const [mutation, code] of [
    [{ priceSats: "5001" }, "WALLET_SIGNATURE_INVALID"],
    [{ network: "signet" }, "WRONG_NETWORK"],
  ] as const) {
    const response = await crcMarketPost(
      new Request("http://localhost/api/crc/v1/market/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer: { ...core.encodeProtocolDto(offer), ...mutation } }),
      }),
      "listings",
      true,
      () => ({
        db: database.db,
        network: "regtest",
        provider: provider as unknown as CoreRpcProvider,
      }),
    );
    expect(response.status).toBe(code === "WRONG_NETWORK" ? 403 : 400);
    expect((await response.json()).error.code).toBe(code);
  }
  expect(node.calls).toHaveLength(rpcCount);
  expect(sign).toHaveBeenCalledTimes(signCount);
}, 60000);

test("API accepts an already signed paid fill after advisory expiry and rejects new expired builds", async () => {
  const before = await sync();
  const [key, allocation] = Object.entries(before.allocations).find(
    ([, a]) => a.deployTxid === deployId && a.scriptHex === aliceScript && a.atoms > 1n,
  )!;
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: deployId,
      ticker: "TEST",
      listedInput: { ...allocation, txid: key.split(":")[0]!, vout: Number(key.split(":")[1]) },
      sellerScriptHex: aliceScript,
      priceSats: 5000n,
      expiryHeight: before.tip!.height + 1,
    },
    aliceKey.privateKey!,
  );
  const id = await activateCrcCoreOffer({
    db: database.db,
    network: "regtest",
    provider,
    offer: core.encodeProtocolDto(offer),
  });
  const args = {
    db: database.db,
    network: "regtest" as const,
    bitcoinNetwork: bitcoin.networks.regtest,
    offerId: id,
    operation: "purchase" as const,
    walletScriptHex: bobScript,
    tokenScriptHex: bobScript,
    walletPublicKeyHex: Buffer.from(bobKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding("bob"),
    minerFeeSats: 1000,
    idempotencyKey: "http-delayed-paid-fill",
    feeScriptHex: protocolScript,
  };
  const built = await buildCrcOfferSession(args);
  const signed = walletSign(built.psbtBase64, true, undefined, bobKey);
  node.mine();
  expect((await sync()).tip!.height).toBe(offer.expiryHeight);
  await expect(
    buildCrcOfferSession({ ...args, idempotencyKey: "http-new-expired-fill" }),
  ).rejects.toMatchObject({ code: "STATE_CHANGED", message: expect.stringMatching(/expired/i) });
  expect(await buildCrcOfferSession(args)).toEqual(built);
  const result = await submit(built.sessionId, signed, "purchase");
  node.mine();
  const after = await sync();
  expect(after.offers[id]!.status).toBe("filled");
  expect(after.allocations[`${result.txid}:2`]).toMatchObject({
    atoms: allocation.atoms,
    scriptHex: bobScript,
  });
}, 60000);

test("API persists READY before failed broadcast and retries exact saved bytes without custody", async () => {
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const built = await buildCrcTradeSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    asset,
    operation: "buy",
    amountAtoms: 100000000000n,
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "http-ready-retry",
    feeScriptHex: protocolScript,
  });
  const signed = walletSign(built.psbtBase64, true),
    count = sign.mock.calls.length;
  failNextBroadcast = true;
  const response = await crcSubmitRoute(
    new Request("http://localhost/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: signed }),
    }),
    "buy",
  );
  expect((await response.json()).error.code).toBe("BROADCAST_FAILED");
  const ready = (
    await database.pool.query("select status,signed_raw_hex,txid from crc_sessions where id=$1", [
      built.sessionId,
    ])
  ).rows[0];
  expect(ready.status).toBe("READY");
  expect(sign).toHaveBeenCalledTimes(count + 1);
  const result = await submit(built.sessionId, "saved receipt retry", "buy");
  expect(result.txid).toBe(ready.txid);
  expect(node.rpc("getrawtransaction", [result.txid])).toBe(ready.signed_raw_hex);
  expect(sign).toHaveBeenCalledTimes(count + 1);
  node.mine();
  await sync();
}, 60000);
test("API admits competing advisory builds but rejects the spent vault before second custody", async () => {
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const builds = [];
  for (const [wallet, key, script] of [
    ["alice", aliceKey, aliceScript],
    ["bob", bobKey, bobScript],
  ] as const) {
    builds.push(
      await buildCrcTradeSession({
        db: database.db,
        network: "regtest",
        bitcoinNetwork: bitcoin.networks.regtest,
        asset,
        operation: "buy",
        amountAtoms: 100000000000n,
        walletScriptHex: script,
        tokenScriptHex: script,
        walletPublicKeyHex: Buffer.from(key.publicKey).toString("hex"),
        paymentFunding: await cacheFunding(wallet),
        minerFeeSats: 1000,
        idempotencyKey: `http-competing-${wallet}`,
        feeScriptHex: protocolScript,
      }),
    );
  }
  const result = await submit(builds[0]!.sessionId, walletSign(builds[0]!.psbtBase64, true), "buy");
  const count = sign.mock.calls.length;
  const response = await crcSubmitRoute(
    new Request("http://localhost/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: builds[1]!.sessionId,
        signedPsbtBase64: walletSign(builds[1]!.psbtBase64, true, undefined, bobKey),
      }),
    }),
    "buy",
  );
  expect((await response.json()).error.code).toBe("STATE_CHANGED");
  expect(sign).toHaveBeenCalledTimes(count);
  node.mine();
  expect((await sync()).allocations[`${result.txid}:1`]!.atoms).toBe(100000000000n);
}, 60000);

test("HTTP sell build replay survives consumed token inputs, funding refresh and fee changes", async () => {
  const before = await sync();
  const funding = await cacheFunding();
  const tokens = Object.keys(before.allocations)
    .filter(
      (key) =>
        before.allocations[key]!.deployTxid === deployId &&
        before.allocations[key]!.scriptHex === aliceScript,
    )
    .map((key) => ({ txid: key.split(":")[0]!, vout: Number(key.split(":")[1]) }));
  const rates = (rate: bigint) => ({
    floorSatPerVb: 1n,
    ceilingSatPerVb: 500n,
    estimated: true,
    tiers: [{ key: "standard" as const, label: "Standard", blocks: 3, satPerVb: rate }],
  });
  await saveFeeObservation(database.db, "regtest", rates(2n), new Date());
  const payload = {
    assetId: `regtest:${deployId}`,
    amountAtoms: "100000000000",
    walletAddress: aliceAddress,
    ordinalsAddress: aliceAddress,
    walletPublicKey: Buffer.from(aliceKey.publicKey).toString("hex"),
    ordinalsPublicKey: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: funding,
    sellerFunding: tokens,
    feeTier: "standard",
    idempotencyKey: "http-sell-build-replay",
  };
  const request = () =>
    new Request("http://localhost/api/crc/v1/backing/sell/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const first = await crcTradeBuildRoute(request(), "sell"),
    body = await first.json();
  expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
  const built = body.data;
  await submit(built.sessionId, walletSign(built.psbtBase64, true), "sell");
  node.mine();
  await sync();
  await saveWalletFundingSnapshot(database.db, "regtest", aliceScript, []);
  await saveFeeObservation(database.db, "regtest", rates(5n), new Date());
  const rpcCount = node.calls.length;
  const retry = await crcTradeBuildRoute(request(), "sell"),
    retried = await retry.json();
  expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true });
  expect(retried.data.sessionId).toBe(built.sessionId);
  expect(retried.data.psbtBase64).toBe(built.psbtBase64);
  expect(retried.data.intent).toEqual(built.intent);
  expect(node.calls).toHaveLength(rpcCount);
}, 60000);
