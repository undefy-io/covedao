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
import { saveWalletFundingSnapshot, PostgresRpcBudget } from "@crclaunch/db";
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
import { buildCrcLaunchSession, buildCrcTradeSession, buildCrcOfferSession, buildCrcTokenSession } from "./crc-build";
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
async function browserFunding(wallet: "alice" | "bob" = "alice") {
  const input = node.funding(wallet);
  const funding = [{ txid: input.txid, vout: input.vout }];
  const rawHex = node.rpc("getrawtransaction", [input.txid]);
  await database.pool.query("delete from cove_wallet_funding where network=$1 and wallet_script=$2", ["regtest", wallet === "alice" ? aliceScript : bobScript]);
  return { funding, paymentFunding: funding, fundingEvidence: { version: 1 as const, network: "regtest", parents: [{ txid: input.txid, rawHex }] } };
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
async function clientSubmit(sessionId: string, signedPsbtBase64: string, operation: "transfer" | "listing" | "purchase" | "cancel") {
  const routeOperation = operation === "purchase" ? "buyer-sign" : operation === "cancel" ? "cancel" : `${operation}-submit`;
  const request = (signed: string) => crcMarketPost(new Request("http://localhost/api/crc/v1/market/"+routeOperation, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({sessionId,signedPsbtBase64:signed,broadcast:"client"}),
  }),routeOperation,true,()=>({db:database.db,network:"regtest",provider: provider as unknown as CoreRpcProvider}));
  const before = node.calls.length;
  const response = await request(signedPsbtBase64), json = await response.json();
  expect(json,JSON.stringify(json)).toMatchObject({ok:true,data:{network:"regtest"}});
  expect(node.calls.slice(before).some(method=>["sendrawtransaction","testmempoolaccept","getrawmempool"].includes(method))).toBe(false);
  const count = node.calls.length, custody = sign.mock.calls.length;
  expect((await (await request("saved receipt")).json()).data).toEqual(json.data);
  expect(node.calls).toHaveLength(count); expect(sign.mock.calls.length).toBe(custody);
  expect(node.broadcast(json.data.rawTxHex)).toBe(json.data.txid);
  return {txid:json.data.txid as string,status:"BROADCAST"};
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
    ...await browserFunding(),
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
    ...await browserFunding(),
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
  const args = {
    db: database.db,
    network: "regtest" as const,
    bitcoinNetwork: bitcoin.networks.regtest,
    asset,
    operation: "buy" as const,
    amountAtoms: 100000000000n,
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "http-wallet-rejection",
    feeScriptHex: protocolScript,
  };
  const built = await buildCrcTradeSession(args);
  const fundingEvidence = { version: 1, network: "regtest", parents: args.paymentFunding.map(input => ({ txid: input.txid, rawHex: node.rpc("getrawtransaction", [input.txid]) })) };
  await database.pool.query("delete from cove_wallet_funding where network='regtest' and wallet_script=$1", [aliceScript]);
  const replayRpcCount = node.calls.length;
  expect(await buildCrcTradeSession({ ...args, fundingEvidence })).toEqual(built);
  expect(node.calls).toHaveLength(replayRpcCount);
  expect((await database.pool.query("select count(*)::int as count from cove_wallet_funding where network='regtest' and wallet_script=$1", [aliceScript])).rows[0].count).toBe(0);
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
    const packet = await browserFunding();
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
          paymentFunding: packet.paymentFunding,
          fundingEvidence: packet.fundingEvidence,
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
    const result = await clientSubmit(built.sessionId, walletSign(built.psbtBase64), operation);
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
  const packet = await browserFunding("bob");
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
        paymentFunding: packet.paymentFunding,
        fundingEvidence: packet.fundingEvidence,
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
        broadcast: "client",
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
  expect(result.status).toBe("READY");
  expect(node.broadcast(result.rawTxHex)).toBe(result.txid);
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
    ...await browserFunding("bob"),
    minerFeeSats: 1000,
    idempotencyKey: "http-cancel",
    feeScriptHex: protocolScript,
  });
  const signed = walletSign(built.psbtBase64, false, undefined, bobKey);
  const result = await clientSubmit(built.sessionId, signed, "cancel");
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
  expect(await clientSubmit(built.sessionId, signed, "cancel")).toEqual(result);
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
  const packet = await browserFunding();
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
    paymentFunding: packet.paymentFunding,
    fundingEvidence: packet.fundingEvidence as unknown,
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
  payload.fundingEvidence = { ...packet.fundingEvidence, parents: [{ ...packet.fundingEvidence.parents[0]!, rawHex: "00" }] };
  const invalid = await crcTradeBuildRoute(request(), "sell");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ ok: false, error: { code: "FUNDING_INPUT_INVALID" } });
  payload.fundingEvidence = undefined;
  const legacy = await crcTradeBuildRoute(request(), "sell");
  expect((await legacy.json()).data.sessionId).toBe(built.sessionId);
  expect(node.calls).toHaveLength(rpcCount);
}, 60000);

const invAtoms = (n: number) => BigInt(n) * core.atomsPerToken;
async function inventoryTrade(
  operation: "buy" | "sell",
  quantity: number,
  owner: "alice" | "bob",
  tag: string,
) {
  const ledger = await sync(),
    script = owner === "alice" ? aliceScript : bobScript,
    key = owner === "alice" ? aliceKey : bobKey;
  const packet = await browserFunding(owner);
  const args = {
    db: database.db,
    network: "regtest" as const,
    bitcoinNetwork: bitcoin.networks.regtest,
    asset: (await readCrcQuoteAsset(database.db, "regtest", deployId))!,
    operation,
    amountAtoms: invAtoms(quantity),
    walletScriptHex: script,
    tokenScriptHex: script,
    walletPublicKeyHex: Buffer.from(key.publicKey).toString("hex"),
    tokenPublicKeyHex: Buffer.from(key.publicKey).toString("hex"),
    ...packet,
    minerFeeSats: 1000,
    idempotencyKey: tag,
    feeScriptHex: protocolScript,
    ...(operation === "sell"
      ? {
          sellerFunding: Object.entries(ledger.allocations)
            .filter(([, a]) => a.deployTxid === deployId && a.scriptHex === script)
            .map(([point]) => ({ txid: point.split(":")[0]!, vout: Number(point.split(":")[1]) })),
        }
      : {}),
  };
  const built = await buildCrcTradeSession(args);
  expect(await buildCrcTradeSession(args)).toEqual(built);
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  const count = sign.mock.calls.length;
  const signed = walletSign(built.psbtBase64, true, undefined, key);
  const result = await submit(built.sessionId, signed, operation);
  expect(sign.mock.calls.length).toBe(count + 1);
  expect(await submit(built.sessionId, signed, operation)).toEqual(result);
  expect(sign.mock.calls.length).toBe(count + 1);
  const [blockHash] = node.mine();
  expect(node.block(blockHash).transactions).toHaveLength(1);
  const after = await sync();
  const actual = node.transaction(result.txid);
  core.validateFinalTransaction(plan, actual, {
    ...ledger,
    config: ledger.assets[deployId]!.config,
  });
  expect(
    plan.inputs.reduce((n, i) => n + core.sats(i.sats), 0n) -
      plan.outputs.reduce((n, o) => n + o.sats, 0n),
  ).toBe(1000n);
  return { built, plan, result, after, blockHash, before: ledger, actual };
}
test("full consumer buy400/sell400/buy1000 records total1000, inventory400 and new600, then repeat100 and reorg", async () => {
  const launch = await buildCrcLaunchSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    ticker: "INVT",
    walletScriptHex: aliceScript,
    tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    funding: await cacheFunding(),
    minerFeeSats: 1000,
    idempotencyKey: "inventory-deploy",
    feeScriptHex: protocolScript,
    guardianXOnly: await backend.xOnlyPubkey(),
    recoveryProfile,
  });
  const launched = await submit(launch.sessionId, walletSign(launch.psbtBase64), "deploy");
  deployId = launched.txid;
  node.mine();
  await sync();
  await inventoryTrade("buy", 400, "alice", "inventory-initial400");
  await inventoryTrade("sell", 400, "alice", "inventory-sell400");
  const mixed = await inventoryTrade("buy", 1000, "bob", "inventory-mixed1000");
  expect(mixed.built.intent).toMatchObject({
    operation: "mint-buy",
    amountAtoms: "100000000000",
    inventoryBuyAtoms: "40000000000",
    newlyMintedAtoms: "60000000000",
  });
  expect(mixed.plan).toMatchObject({
    inventoryBuyAtoms: invAtoms(400),
    newlyMintedAtoms: invAtoms(600),
    grossSats: 27n,
    protocolFeeSats: 5013n,
    creatorFeeSats: 546n,
  });
  expect(mixed.after.assets[deployId]).toMatchObject({
    issuedAtoms: invAtoms(1000),
    inventoryAtoms: 0n,
  });
  expect(mixed.after.allocations[`${mixed.result.txid}:1`]).toMatchObject({
    atoms: invAtoms(1000),
    scriptHex: bobScript,
  });
  const { readCrcActivity, readCrcTrades, readCrcBalance } = await import("./crc-read");
  expect(await readCrcBalance(database.db, "regtest", deployId, bobScript)).toBe(invAtoms(1000));
  expect((await readCrcActivity(database.db, "regtest", deployId))[0]).toMatchObject({
    kind: "mint",
    tradeSide: "buy",
    amountAtoms: "100000000000",
    inventoryBuyAtoms: "40000000000",
    newlyMintedAtoms: "60000000000",
  });
  expect((await readCrcTrades(database.db, "regtest", deployId)).at(-1)).toMatchObject({
    amountAtoms: "100000000000",
    totalPriceSats: "27",
  });
  expect((await state.loadCrcCoreLedger(database.db, "regtest"))!.assets).toEqual(
    mixed.after.assets,
  );
  await inventoryTrade("buy", 100, "bob", "inventory-repeat100");
  expect(await readCrcBalance(database.db, "regtest", deployId, bobScript)).toBe(invAtoms(1100));
  node.rpc("invalidateblock", [mixed.blockHash]);
  const restored = await sync();
  expect(restored.assets[deployId]).toMatchObject({
    issuedAtoms: invAtoms(400),
    inventoryAtoms: invAtoms(400),
  });
  expect(await readCrcBalance(database.db, "regtest", deployId, bobScript)).toBe(0n);
  expect(
    (await readCrcActivity(database.db, "regtest", deployId)).some(
      (x) => x.txid === mixed.result.txid,
    ),
  ).toBe(false);
  node.clearOrphanMempool();
  node.rpc("abandontransaction", [mixed.result.txid], "bob");
  const replacement = await inventoryTrade("buy", 500, "bob", "inventory-replacement500");
  expect(replacement.after.tip!.height).toBe(mixed.after.tip!.height);
  expect(replacement.after.tip!.hash).not.toBe(mixed.after.tip!.hash);
  expect(replacement.after.assets[deployId]).toMatchObject({
    issuedAtoms: invAtoms(500),
    inventoryAtoms: 0n,
  });
}, 120000);

test("stored buy intent cannot misstate receipt or split while wallet/Guardian signing is pending", async () => {
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const built = await buildCrcTradeSession({
    db: database.db,
    network: "regtest",
    bitcoinNetwork: bitcoin.networks.regtest,
    asset,
    operation: "buy",
    amountAtoms: invAtoms(100),
    walletScriptHex: bobScript,
    tokenScriptHex: bobScript,
    walletPublicKeyHex: Buffer.from(bobKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding("bob"),
    minerFeeSats: 1000,
    idempotencyKey: "inventory-forged-intent",
    feeScriptHex: protocolScript,
  });
  const signed = walletSign(built.psbtBase64, true, undefined, bobKey);
  const count = sign.mock.calls.length,
    rpcCount = node.calls.length;
  try {
    for (const changed of [
      { amountAtoms: "60000000000" },
      { inventoryBuyAtoms: "10000000000" },
      { newlyMintedAtoms: "0" },
      { operation: "inventory-buy" },
    ]) {
      await database.pool.query("update crc_sessions set trusted_json=$2 where id=$1", [
        built.sessionId,
        JSON.stringify({ ...built.intent, ...changed }),
      ]);
      const response = await crcSubmitRoute(
        new Request("http://localhost/api/crc/v1/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: signed }),
        }),
        "buy",
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "CLIENT_INTENT_MISMATCH" },
      });
    }
    expect(sign.mock.calls.length).toBe(count);
    expect(node.calls.length).toBe(rpcCount);
  } finally {
    await database.pool.query("update crc_sessions set trusted_json=$2 where id=$1", [
      built.sessionId,
      JSON.stringify(built.intent),
    ]);
  }
}, 60000);


test("consumer buy400/list300/buyer-only fill returns100 without an extra split transaction", async () => {
  await inventoryTrade("buy",400,"alice","inventory-market-buy400");
  const before=await sync();
  const tokens=Object.entries(before.allocations).filter(([,a])=>a.deployTxid===deployId&&a.scriptHex===aliceScript).map(([p])=>({txid:p.split(":")[0]!,vout:Number(p.split(":")[1])}));
  const common={db:database.db,network:"regtest" as const,bitcoinNetwork:bitcoin.networks.regtest,walletScriptHex:aliceScript,tokenScriptHex:aliceScript,walletPublicKeyHex:Buffer.from(aliceKey.publicKey).toString("hex"),tokenPublicKeyHex:Buffer.from(aliceKey.publicKey).toString("hex"),paymentFunding:await cacheFunding(),minerFeeSats:1000,feeScriptHex:protocolScript};
  const built=await buildCrcTokenSession({...common,deployTxid:deployId,operation:"listing",amountAtoms:invAtoms(300),recipientScriptHex:aliceScript,priceSats:5000n,tokenFunding:tokens,minerFeeSats:undefined,feeRateSatPerVb:2,idempotencyKey:"inventory-list300"});
  expect(built.intent.feeRateSatPerVb).toBe(2);
  expect(built.intent.minerFeeSats).toBeLessThanOrEqual(20000);
  const custodyCount=sign.mock.calls.length;
  const listing=await submit(built.sessionId,walletSign(built.psbtBase64),"listing");
  const [hash]=node.mine(); expect(node.block(hash).transactions).toHaveLength(1);
  const listed=await sync();
  const {readCrcBalance}=await import("./crc-read");
  expect(await readCrcBalance(database.db,"regtest",deployId,aliceScript)).toBe(invAtoms(400));
  const allocation=listed.allocations[`${listing.txid}:1`]!;
  expect(allocation.atoms).toBe(invAtoms(300));
  expect(Object.values(listed.allocations).filter(a=>a.deployTxid===deployId&&a.scriptHex===aliceScript&&a.atoms===invAtoms(100))).toHaveLength(1);
  const offer=await authorizeOffer({network:"regtest",deployTxid:deployId,ticker:listed.assets[deployId]!.config.ticker,listedInput:{...allocation,txid:listing.txid,vout:1},sellerScriptHex:aliceScript,priceSats:5000n,expiryHeight:listed.tip!.height+10},aliceKey.privateKey!);
  const id=await activateCrcCoreOffer({db:database.db,network:"regtest",provider,offer:core.encodeProtocolDto(offer)});
  const purchase=await buildCrcOfferSession({...common,offerId:id,operation:"purchase",walletScriptHex:bobScript,tokenScriptHex:bobScript,walletPublicKeyHex:Buffer.from(bobKey.publicKey).toString("hex"),tokenPublicKeyHex:Buffer.from(bobKey.publicKey).toString("hex"),paymentFunding:await cacheFunding("bob"),idempotencyKey:"inventory-market-fill300"});
  const fill=await submit(purchase.sessionId,walletSign(purchase.psbtBase64,true,undefined,bobKey),"purchase");
  const [fillHash]=node.mine(); expect(node.block(fillHash).transactions).toHaveLength(1);
  const after=await sync();
  expect(sign.mock.calls.length).toBe(custodyCount);
  expect(after.allocations[`${fill.txid}:2`]).toMatchObject({atoms:invAtoms(300),scriptHex:bobScript});
  expect(await readCrcBalance(database.db,"regtest",deployId,aliceScript)).toBe(invAtoms(100));
  expect(after.assets[deployId]).toEqual(listed.assets[deployId]);
  expect(after.offers[id]!.status).toBe("filled");
},60000);


test("three-input sell retains live fences and READY recovery with fewer RPC calls at the real shared quota", async () => {
  await inventoryTrade("buy", 1000, "alice", "latency-fund1000");
  const ledger = await sync();
  const [outpoint] = Object.entries(ledger.allocations).find(([, coin]) => coin.deployTxid === deployId && coin.scriptHex === aliceScript && coin.atoms === invAtoms(1000))!;
  const asset = (await readCrcQuoteAsset(database.db, "regtest", deployId))!;
  const built = await buildCrcTradeSession({ db: database.db, network: "regtest", bitcoinNetwork: bitcoin.networks.regtest, asset,
    operation: "sell", amountAtoms: invAtoms(700), walletScriptHex: aliceScript, tokenScriptHex: aliceScript,
    walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"), tokenPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    paymentFunding: await cacheFunding(), sellerFunding: [{ txid: outpoint!.split(":")[0]!, vout: Number(outpoint!.split(":")[1]) }],
    minerFeeSats: 1000, idempotencyKey: "latency-sell700", feeScriptHex: protocolScript });
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  expect(plan.inputs).toHaveLength(3);
  const account = crypto.randomUUID();
  const calls: { lane: string; method: string; budgetMs: number; elapsedMs: number }[] = [];
  const paced = (lane: "public" | "guardian") => {
    const budget = new PostgresRpcBudget(database.db, account, lane, 3);
    return Object.fromEntries(Object.entries(provider).map(([method, fn]) => [method, async (...args: unknown[]) => {
      const queued = performance.now(); const release = await budget.acquire(AbortSignal.timeout(15000));
      const started = performance.now();
      try {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (method === "broadcastTransaction") {
          const rows = await database.pool.query("select status from crc_sessions where id=$1", [built.sessionId]);
          expect(rows.rows[0].status).toBe("READY");
        }
        return await (fn as (...params: unknown[]) => Promise<unknown>)(...args);
      } finally {
        calls.push({ lane, method, budgetMs: Math.round(started-queued), elapsedMs: Math.round(performance.now()-started) }); await release();
      }
    }]));
  };
  const originalService = service, publicProvider = paced("public");
  injected.services.provider = publicProvider;
  service = new CrcGuardianSigningService({ db: database.db, core: paced("guardian") as never, custodyBackend: backend,
    guardianXOnly: await backend.xOnlyPubkey(), recoveryProfile, network: "regtest", protocolScript: Buffer.from(protocolScript, "hex"), maxMinerFeeSats: 20000n });
  try {
    const before = sign.mock.calls.length, started = performance.now();
    const response = await crcSubmitRoute(new Request("http://localhost/submit", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: walletSign(built.psbtBase64, true) }) }), "sell");
    const body = await response.json(); expect(body.ok, JSON.stringify(body)).toBe(true);
    const durationMs = Math.round(performance.now()-started);
    const freshCalls = [...calls];
    minedEvidence.push({ latency: { durationMs, modeledTransportMs: 200, quotaPerSecond: 3, inputs: plan.inputs.length, calls: freshCalls, serverTiming: response.headers.get("server-timing") } });
    expect(freshCalls.filter(call => call.lane === "public")).toHaveLength(12);
    expect(freshCalls.filter(call => call.lane === "guardian")).toHaveLength(10);
    expect(freshCalls.filter(call => call.method === "observeTransaction")).toHaveLength(0);
    expect(freshCalls.filter(call => call.method === "getTxout")).toHaveLength(12);
    expect(durationMs).toBeLessThan(16000);
    expect(response.headers.get("server-timing")).toContain("guardian;dur=");
    expect(sign.mock.calls.length).toBe(before + 1);
    calls.length = 0;
    expect(await submit(built.sessionId, "saved receipt retry", "sell")).toEqual(body.data);
    expect(calls.map(call => call.method)).toEqual(["getBlockchainInfo", "observeTransaction"]);
    expect(sign.mock.calls.length).toBe(before + 1);
    node.mine(); await sync();
  } finally { injected.services.provider = provider; service = originalService; }
}, 60000);

test("client preparation saves exact READY bytes without relay, replays locally, and indexer observes browser broadcasts", async () => {
  const launch = await buildCrcLaunchSession({ db: database.db, network: "regtest", bitcoinNetwork: bitcoin.networks.regtest,
    ticker: "RDY", walletScriptHex: aliceScript, tokenScriptHex: aliceScript, walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
    ...await browserFunding(), minerFeeSats: 1000, idempotencyKey: "browser-ready-launch", feeScriptHex: protocolScript,
    guardianXOnly: await backend.xOnlyPubkey(), recoveryProfile });
  if (!(await state.loadCrcCoreLedger(database.db, "regtest"))) await state.initializeCrcLedger(database.db, core.decodeProtocolDto<core.Config>(launch.intent.coreConfig), { activationHeight });
  if (!service) service = new CrcGuardianSigningService({ db: database.db, core: provider, custodyBackend: backend, guardianXOnly: await backend.xOnlyPubkey(), recoveryProfile, network: "regtest", protocolScript: Buffer.from(protocolScript, "hex"), maxMinerFeeSats: 20000n });
  const prepared = async (built: {sessionId: string; psbtBase64: string}, operation: "deploy" | "buy" | "sell", signature: string) => {
    const count = node.calls.length, started = performance.now();
    const response = await crcSubmitRoute(new Request("http://localhost/submit", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: signature, broadcast: "client" }) }), operation);
    const json = await response.json();
    expect(json, JSON.stringify(json)).toMatchObject({ ok: true, data: { status: "READY", network: "regtest" } });
    expect(core.parseRawTransaction(json.data.rawTxHex).txid).toBe(json.data.txid);
    expect(node.calls.slice(count).some(call => ["sendrawtransaction", "testmempoolaccept", "getrawmempool"].includes(call))).toBe(false);
    minedEvidence.push({clientPreparation:{operation, inputs:bitcoin.Psbt.fromBase64(built.psbtBase64).inputCount, calls:node.calls.slice(count), durationMs:Math.round(performance.now()-started), cachedRpcCalls:0}});
    const row = (await database.pool.query("select status,signed_raw_hex,txid from crc_sessions where id=$1", [built.sessionId])).rows[0];
    expect(row).toMatchObject({ status: "READY", signed_raw_hex: json.data.rawTxHex, txid: json.data.txid });
    await database.pool.query("update crc_sessions set expires_at=now()-interval '1 hour' where id=$1",[built.sessionId]);
    const replayCount = node.calls.length, custodyCount = sign.mock.calls.length;
    const repeat = await crcSubmitRoute(new Request("http://localhost/submit", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: built.sessionId, signedPsbtBase64: "saved receipt", broadcast: "client" }) }), operation);
    expect((await repeat.json()).data).toEqual(json.data);
    expect(node.calls).toHaveLength(replayCount); expect(sign.mock.calls.length).toBe(custodyCount);
    // The fixture now acts as the browser, using its own connection to Core.
    expect(node.broadcast(json.data.rawTxHex)).toBe(json.data.txid);
    node.mine(); const indexed = await sync();
    expect((await database.pool.query("select status from crc_sessions where id=$1", [built.sessionId])).rows[0].status).toBe("BROADCAST");
    return { receipt: json.data, indexed };
  };
  // A competing claim loses before any live RPC, even with valid wallet signatures.
  await database.pool.query("update crc_sessions set status='SIGNING',claim_id=$2,updated_at=now() where id=$1",[launch.sessionId,crypto.randomUUID()]);
  const claimRpcCount=node.calls.length, claimCustodyCount=sign.mock.calls.length;
  const conflict=await crcSubmitRoute(new Request("http://localhost/submit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:launch.sessionId,signedPsbtBase64:walletSign(launch.psbtBase64),broadcast:"client"})}),"deploy");
  expect((await conflict.json()).error.code).toBe("STATE_CHANGED");
  expect(node.calls).toHaveLength(claimRpcCount);expect(sign.mock.calls.length).toBe(claimCustodyCount);
  await database.pool.query("update crc_sessions set status='BUILT',claim_id=null where id=$1",[launch.sessionId]);
  const deployed = await prepared(launch, "deploy", walletSign(launch.psbtBase64));
  const oldDeployment = deployId; deployId = deployed.receipt.txid;
  try {
    for (const [index, operation, quantity] of [[0, "buy", 400], [1, "sell", 400], [2, "buy", 1000]] as const) {
      const ledger = await sync();
      const built = await buildCrcTradeSession({ db: database.db, network: "regtest", bitcoinNetwork: bitcoin.networks.regtest,
        asset: (await readCrcQuoteAsset(database.db, "regtest", deployId))!, operation, amountAtoms: invAtoms(quantity),
        walletScriptHex: aliceScript, tokenScriptHex: aliceScript, walletPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"),
        tokenPublicKeyHex: Buffer.from(aliceKey.publicKey).toString("hex"), ...await browserFunding(), minerFeeSats: 1000,
        idempotencyKey: `browser-ready-trade${index}`, feeScriptHex: protocolScript,
        ...(operation === "sell" ? { sellerFunding: Object.entries(ledger.allocations).filter(([, a]) => a.deployTxid === deployId && a.scriptHex === aliceScript).map(([p]) => ({ txid: p.split(":")[0]!, vout: Number(p.split(":")[1]) })) } : {}) });
      await prepared(built, operation, walletSign(built.psbtBase64, true));
    }
  } finally { deployId = oldDeployment; }
}, 60000);

test("public submit and market routes reject stale frontend relay requests before RPC",async()=>{
  const count=node.calls.length, custody=sign.mock.calls.length, previous=injected.services.config.network;
  const body={sessionId:crypto.randomUUID(),signedPsbtBase64:"saved receipt"};
  try {
    injected.services.config.network="signet";
    for(const broadcast of [undefined,"server"]) {
      const req=()=>new Request("http://localhost/submit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,broadcast})});
      expect((await crcSubmitRoute(req(),"buy")).status).toBe(409);
      const market=await crcMarketPost(req(),"buyer-sign",true,()=>({db:database.db,network:"signet",provider:provider as unknown as CoreRpcProvider}));
      expect(market.status).toBe(broadcast===undefined?409:400);
    }
    expect(node.calls).toHaveLength(count);expect(sign.mock.calls.length).toBe(custody);
  } finally {injected.services.config.network=previous;}
});
