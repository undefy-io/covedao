import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { sql, eq } from "drizzle-orm";
import { createDb, schema } from "@crclaunch/db";
import { stateHashV2, CoveChainView } from "@crclaunch/cove-covenant";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import { hashMainnetProfile } from "@crclaunch/cove-mainnet";
import { buildDeployPsbtV3, buildMintPsbtV3, buildRedeemPsbtV3, HttpGuardianTransport, RemoteGuardianTransitionSigner, TestGuardianCustodyBackend, chainFundingChecker } from "@crclaunch/cove-guardian/v3";
import { buildGuardianService, recoveryProfileFromMainnet } from "./service.js";
import { createGuardianHttpServer } from "./http.js";
import { resolveGuardianBoot } from "./boot.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";
const servers: Server[] = [];
const initialHash = "11".repeat(32);
async function listen(server: Server): Promise<string> {
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });

async function fixture() {
  const db = createDb(url!);
  const boot = resolveGuardianBoot({ COVE_NETWORK: "regtest", COVE_DATABASE_URL: url!, COVE_BITCOIN_RPC_URL: "http://127.0.0.1:18443",
    GUARDIAN_AUTH_TOKEN: "fixture-auth", GUARDIAN_TEST_KEY_HEX: "42".repeat(32) });
  const profile = boot.profile.profile;
  const guardianXOnly = Buffer.from(profile.guardianXOnly!, "hex"), recoveryProfile = recoveryProfileFromMainnet(profile);
  const recoveryKeyXOnly = recoveryProfile.recoveryPubkeys[0]!, feeScript = Buffer.from(profile.feeScript!, "hex");
  const privateKey = Buffer.alloc(32, 0x46), publicKey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
  const wallet = { publicKey, sign: (hash: Buffer) => Buffer.from(ecc.sign(hash, privateKey)) };
  const walletScript = bitcoin.payments.p2wpkh({ pubkey: publicKey }).output!;
  const creatorScript = walletScript, deployTxid = randomBytes(32).toString("hex"), nonce = randomBytes(32);
  const deploy = buildDeployPsbtV3({ network: bitcoin.networks.regtest, feeScript,
    identity: { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "TEST", tokenNonce: nonce },
    guardianXOnly, recoveryKeyXOnly, recoveryProfile, creatorScript,
    deployerInputs: [{ txid: randomBytes(32).toString("hex"), vout: 0, script: walletScript, valueSats: 1_000_000n }],
    deployerChangeScript: walletScript, minerFeeSats: 1000n });
  profile.canary = { ...profile.canary, allowedTokenIds: [deploy.tokenId.toString("hex")], minMintGrossSats: 0n, maxSingleBuySats: 10_000_000n };
  const resolved = { ...boot.profile, profile, profileHash: hashMainnetProfile(profile) };
  await db.insert(schema.coveV3Cursor).values({ network: "regtest", height: 101n, blockHash: initialHash, stateRoot: "22".repeat(32) });
  await db.insert(schema.coveV3Tokens).values({ network: "regtest", tokenId: deploy.tokenId.toString("hex"), ticker: "TEST", policyVersion: 3,
    nonce: nonce.toString("hex"), deployTxid, deployHeight: 101n, deployBlockHash: initialHash, creatorScript: creatorScript.toString("hex") });
  await db.insert(schema.coveV3BackingStates).values({ network: "regtest", tokenId: deploy.tokenId.toString("hex"), stateHash: stateHashV2(deploy.s0),
    stateVersion: 2, policyVersion: 3, issuedSupplyAtoms: 0n, backingSats: 0n, curveStage: deploy.s0.curveStage, txid: deployTxid, vout: 1,
    scriptPubKey: deploy.vault.scriptPubKey.toString("hex"), btcValue: 10_000n, blockHeight: 101n, blockHash: initialHash });
  const raw = new Map<string, string>(), mempool = new Set<string>();
  const outputs = new Map<string, { script: string; value: bigint; confirmations: number }>();
  outputs.set(`${deployTxid}:1`, { script: deploy.vault.scriptPubKey.toString("hex"), value: 10_000n, confirmations: 1 });
  let tipHash = initialHash, observationError = false;
  let changeOnRaw: (() => Promise<void>) | undefined;
  const rpcUrl = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params: unknown[] };
    const txid = String(body.params[0]);
    let result: unknown, error: { code: number; message: string } | null = null;
    switch (body.method) {
      case "getblockchaininfo": result = { chain: "regtest", blocks: 101, headers: 101, bestblockhash: tipHash, initialblockdownload: false }; break;
      case "getblockhash": result = tipHash; break;
      case "gettxout": {
        const output = outputs.get(`${txid}:${body.params[1]}`);
        result = output ? { scriptPubKey: { hex: output.script }, value: Number(output.value) / 100_000_000, confirmations: output.confirmations, bestblock: tipHash } : null;
        break;
      }
      case "getmempoolentry": if (observationError) error = { code: -1, message: "fixture provider unavailable" };
        else if (mempool.has(txid)) result = { vsize: 200 };
        else error = { code: -5, message: "transaction not in mempool" }; break;
      case "getrawtransaction":
        if (changeOnRaw) { const change = changeOnRaw; changeOnRaw = undefined; await change(); }
        if (!raw.has(txid)) error = { code: -5, message: "transaction unavailable" };
        else result = body.params[1] === true ? { txid, hex: raw.get(txid) } : raw.get(txid); break;
      default: error = { code: -32601, message: "unsupported fixture method" };
    }
    res.writeHead(error ? 500 : 200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: body.id, result, error }));
  }));
  const built = buildGuardianService({ profile: resolved, releaseId: "integration", databaseUrl: url!, network: "regtest",
    custodyBackend: new TestGuardianCustodyBackend(Buffer.alloc(32, 0x42)), coreRpc: { url: rpcUrl } });
  const endpoint = await listen(createGuardianHttpServer({ transport: built.transport, authToken: "fixture-auth" }));
  const remote = new RemoteGuardianTransitionSigner(new HttpGuardianTransport(endpoint, "fixture-auth"), resolved.profileHash, guardianXOnly.toString("hex"));
  const view = new CoveChainView();
  const request = (psbt: bitcoin.Psbt) => ({ psbt, view, network: "regtest" as const, recoveryKeyXOnly, recoveryProfile, feeScript,
    fundingChecker: chainFundingChecker({ chain: built.core, isCoveCarrier: async () => false }) });
  const mint = (state = deploy.s0, backing = { txid: deployTxid, script: deploy.vault.scriptPubKey }, amount = 1_000_000n * 100_000_000n, locktime = 0) => {
    const coin = randomBytes(32).toString("hex");
    outputs.set(`${coin}:0`, { script: walletScript.toString("hex"), value: 10_000_000n, confirmations: 1 });
    const result = buildMintPsbtV3({ network: bitcoin.networks.regtest, tokenId: deploy.tokenId, prevState: state,
      prevBacking: { ...backing, vout: 1, valueSats: 10_000n + state.backingSats }, mintAmountAtoms: amount, guardianXOnly, recoveryKeyXOnly,
      recoveryProfile, buyerInputs: [{ txid: coin, vout: 0, script: walletScript, valueSats: 10_000_000n }], buyerCarrierScript: walletScript,
      buyerChangeScript: walletScript, feeScript, creatorScript, minerFeeSats: 1000n, buyFeeBps: BigInt(profile.buyFeeBps!) });
    result.psbt.setLocktime(locktime);
    result.psbt.signInput(1, wallet); result.psbt.finalizeInput(1); return result;
  };
  const accept = (psbt: bitcoin.Psbt) => {
    const tx = psbt.extractTransaction(), txid = tx.getId(); raw.set(txid, tx.toHex()); mempool.add(txid);
    for (const input of tx.ins) outputs.delete(`${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`);
    tx.outs.forEach((output, index) => outputs.set(`${txid}:${index}`, { script: output.script.toString("hex"), value: BigInt(output.value), confirmations: 0 }));
    return txid;
  };
  return { db, deploy, remote, request, mint, accept, raw, mempool, outputs, wallet, walletScript, recoveryKeyXOnly, recoveryProfile, feeScript, guardianXOnly,
    setTip: (hash: string) => { tipHash = hash; }, setObservationError: (error: boolean) => { observationError = error; },
    onRaw: (change: () => Promise<void>) => { changeOnRaw = change; } };
}

describe.skipIf(!isolated)("production Guardian HTTP pending ancestry on isolated PostgreSQL", () => {
  beforeEach(async () => { await createDb(url!).execute(sql`truncate cove_v3_cursor, cove_v3_tokens, cove_v3_backing_states, cove_v3_token_utxos, cove_v3_signing_journal, cove_v3_guardian_audit`); });

  it("signs two mints and a redeem before a block, and recovers an older signature after the view disappears", async () => {
    const f = await fixture(), first = f.mint(undefined, undefined, undefined, 10), original = first.psbt.toBase64();
    expect(await f.remote.signMint(f.request(first.psbt))).toMatchObject({ ok: true });
    const firstWitness = first.psbt.data.inputs[0]!.finalScriptWitness;
    const firstTxid = f.accept(first.psbt);
    const second = f.mint(first.nextState, { txid: firstTxid, script: first.nextVault.scriptPubKey });
    expect(await f.remote.signMint(f.request(second.psbt))).toMatchObject({ ok: true });
    const secondTxid = f.accept(second.psbt);
    const redeem = buildRedeemPsbtV3({ network: bitcoin.networks.regtest, tokenId: f.deploy.tokenId, prevState: second.nextState,
      prevBacking: { txid: secondTxid, vout: 1, script: second.nextVault.scriptPubKey, valueSats: 10_000n + second.nextState.backingSats },
      redeemAmountAtoms: 1_000_000n * 100_000_000n, tokenInputs: [{ txid: firstTxid, vout: 2, script: f.walletScript, valueSats: 1000n }],
      tokenInputTotalAtoms: 1_000_000n * 100_000_000n, guardianXOnly: f.guardianXOnly, recoveryKeyXOnly: f.recoveryKeyXOnly,
      recoveryProfile: f.recoveryProfile, sellerPayoutScript: f.walletScript, sellerChangeScript: f.walletScript,
      feeScript: f.feeScript, minerFeeSats: 1000n, redeemFeeBps: 100n });
    redeem.psbt.signInput(1, f.wallet); redeem.psbt.finalizeInput(1);
    const carrier = f.outputs.get(`${firstTxid}:2`)!;
    f.outputs.delete(`${firstTxid}:2`);
    expect((await f.remote.signRedeem(f.request(redeem.psbt))).ok).toBe(false);
    const held = await f.db.select().from(schema.coveV3SigningJournal).where(eq(schema.coveV3SigningJournal.backingTxid, secondTxid));
    expect(held).toEqual([]);
    f.outputs.set(`${firstTxid}:2`, carrier);
    expect(await f.remote.signRedeem(f.request(redeem.psbt))).toMatchObject({ ok: true });
    await f.db.update(schema.coveV3Cursor).set({ rebuilding: true }); f.setObservationError(true);
    const retry = bitcoin.Psbt.fromBase64(original);
    expect(await f.remote.signMint(f.request(retry))).toMatchObject({ ok: true });
    expect(retry.data.inputs[0]!.finalScriptWitness).toEqual(firstWitness);
  });

  it.each(["evicted", "provider", "reorg", "indexer", "signature", "disconnected", "unsigned", "wrong_vault", "wrong_token", "depth"])("rejects %s ancestry before signing a successor", async (failure) => {
    const f = await fixture(), first = f.mint();
    expect(await f.remote.signMint(f.request(first.psbt))).toMatchObject({ ok: true });
    const txid = f.accept(first.psbt), second = f.mint(first.nextState, { txid, script: first.nextVault.scriptPubKey });
    if (failure === "evicted") f.mempool.delete(txid);
    if (failure === "provider") f.setObservationError(true);
    if (failure === "reorg") f.onRaw(async () => f.setTip("33".repeat(32)));
    if (failure === "indexer") f.onRaw(async () => { await f.db.update(schema.coveV3Cursor).set({ rebuilding: true }); });
    if (failure === "signature") { const tx = bitcoin.Transaction.fromHex(f.raw.get(txid)!); const sig = tx.ins[0]!.witness[0]!; sig[0] = sig[0]! ^ 1; f.raw.set(txid, tx.toHex()); }
    if (failure === "disconnected") await f.db.delete(schema.coveV3SigningJournal);
    if (failure === "unsigned") { const input = second.psbt.data.inputs[1]!; delete input.finalScriptWitness; }
    if (failure === "wrong_vault") f.outputs.get(`${txid}:1`)!.script = "5120" + "44".repeat(32);
    if (failure === "wrong_token") {
      const tx = bitcoin.Transaction.fromHex(f.raw.get(txid)!); tx.outs[0]!.script[10] = tx.outs[0]!.script[10]! ^ 1; f.raw.set(txid, tx.toHex());
    }
    if (failure === "depth") {
      let parent = txid;
      for (let depth = 0; depth < 24; depth++) {
        const tx = bitcoin.Transaction.fromHex(f.raw.get(txid)!); tx.ins[0]!.hash = Buffer.from(parent, "hex").reverse();
        parent = tx.getId(); f.raw.set(parent, tx.toHex()); f.mempool.add(parent);
      }
      const deep = f.mint(first.nextState, { txid: parent, script: first.nextVault.scriptPubKey });
      expect((await f.remote.signMint(f.request(deep.psbt))).ok).toBe(false);
      return;
    }
    expect((await f.remote.signMint(f.request(second.psbt))).ok).toBe(false);
    const successors = await f.db.select().from(schema.coveV3SigningJournal).where(eq(schema.coveV3SigningJournal.backingTxid, txid));
    expect(successors).toEqual([]);
  });
});
