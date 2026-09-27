import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { s0StateV2 } from "@crclaunch/cove-covenant";
import {
  buildRecoveryDraft,
  signRecoverySighash,
  addRecoverySignature,
  finalizeRecovery,
} from "./recovery.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

/**
 * REAL Core regtest recovery consensus matrix (§7). Proves both MAINNET1
 * recovery shapes against Bitcoin Core. No mainnet; deterministic test keys only.
 */

const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";

const WALLET = "cove-recovery";

let id = 0;
async function call<T>(method: string, params: unknown[], path: string): Promise<T> {
  const res = await fetch(`${RPC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64")}` },
    body: JSON.stringify({ jsonrpc: "1.0", id: `${++id}`, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json()) as { result?: T; error?: { message?: string } };
  if (!res.ok || j.error) throw new Error(`RPC ${method}: ${j.error?.message ?? "err"}`);
  return j.result as T;
}

/** Node-level RPC (no wallet context): createwallet, sendrawtransaction, … */
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return call<T>(method, params, "");
}

/**
 * Wallet RPC, addressed to this script's own wallet.
 *
 * Core refuses an unqualified wallet call whenever more than one wallet is
 * loaded, and this script loads its own — so on any node that already has a
 * wallet open (a running dev stack, for instance) the unqualified form fails.
 * Routing through /wallet/<name> is what Core asks for and removes the
 * dependency on what else happens to be loaded.
 */
async function wrpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return call<T>(method, params, `/wallet/${WALLET}`);
}

function priv(byte: number): string {
  return Buffer.alloc(32, byte).toString("hex");
}
function xonly(byte: number): Buffer {
  const k = ECPair.fromPrivateKey(Buffer.alloc(32, byte));
  return Buffer.from(k.publicKey.subarray(1));
}

const CSV = 3; // short for the test; production value is committed in the profile
const K1 = xonly(0x51);
const K2 = xonly(0x52);
const K3 = xonly(0x53);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const provider = new CoreRpcProvider({ url: RPC_URL, user: RPC_USER, password: RPC_PASSWORD });
  try { await rpc("createwallet", [WALLET, false, false, "", false, true, false]); } catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; }
  try { await rpc("loadwallet", [WALLET]); } catch (e) { if (!/already loaded/i.test((e as Error).message)) throw e; }
  await rpc("generatetoaddress", [101, await wrpc<string>("getnewaddress")]);

  const state = s0StateV2({ tokenId: "ab".repeat(32) });
  const destinationScript = bitcoin.payments.p2wpkh({ pubkey: ECPair.fromPrivateKey(Buffer.alloc(32, 0x77)).publicKey, network: bitcoin.networks.regtest }).output!;
  const recoveryProfile = { profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1" as const, recoveryCsvBlocks: CSV, recoveryThreshold: 2, recoveryPubkeys: [K1, K2, K3] };

  const vault = buildRecoveryDraft({
    state,
    guardianXOnly: xonly(0x42),
    recoveryProfile,
    outpoint: { txid: "00".repeat(32), vout: 0 },
    vaultValueSats: 10_000n,
    destinationScript,
    minerFeeSats: 1000n,
    maxMinerFeeSats: 2000n,
  }).vault;
  const vaultAddress = vault.address;
  const vaultScript = vault.scriptPubKey;

  // Fund the vault.
  const fundTxid = await wrpc<string>("sendtoaddress", [vaultAddress, 1.0]);
  await rpc("generatetoaddress", [1, await wrpc<string>("getnewaddress")]);
  const raw = await provider.getRawTransaction(fundTxid);
  const fundTx = bitcoin.Transaction.fromHex(raw);
  const vout = fundTx.outs.findIndex((o) => o.script.equals(vaultScript));
  assert(vout >= 0, "funding output not found");

  const spend = buildRecoveryDraft({
    state,
    guardianXOnly: xonly(0x42),
    recoveryProfile,
    outpoint: { txid: fundTxid, vout },
    vaultValueSats: BigInt(fundTx.outs[vout]!.value),
    destinationScript,
    minerFeeSats: 1000n,
    maxMinerFeeSats: 2000n,
  });

  // 1-of-3 finalize must fail.
  const s1 = signRecoverySighash(spend.sighash, priv(0x51));
  addRecoverySignature(spend, K1, s1);
  let rejected = false;
  try { finalizeRecovery(spend); } catch { rejected = true; }
  assert(rejected, "1-of-3 must not finalize");

  // Add the second signature → 2-of-3.
  const s2 = signRecoverySighash(spend.sighash, priv(0x52));
  addRecoverySignature(spend, K2, s2);
  const hex = finalizeRecovery(spend);

  // Before CSV maturity (only 1 block since funding) → testmempoolaccept rejects.
  const early = await provider.testMempoolAccept(hex);
  assert(early.allowed === false, "recovery must be rejected before CSV maturity");

  // Mine to maturity.
  await rpc("generatetoaddress", [CSV, await wrpc<string>("getnewaddress")]);

  // Now 2-of-3 accepts.
  const accept = await provider.testMempoolAccept(hex);
  assert(accept.allowed === true, `recovery rejected at maturity: ${accept.rejectReason}`);

  // Malformed witness (flip a byte in a signature) → reject.
  const tx = bitcoin.Transaction.fromHex(hex);
  const w0 = tx.ins[0]!.witness[0]!;
  const mutated = bitcoin.Transaction.fromHex(hex);
  mutated.ins[0]!.witness[0]![0] = (w0[0] ?? 0) ^ 0xff;
  const bad = await provider.testMempoolAccept(mutated.toHex());
  assert(bad.allowed === false, "malformed recovery witness must be rejected");

  // Broadcast the valid recovery + mine.
  const txid = await provider.broadcastTransaction(hex);
  await rpc("generatetoaddress", [1, await wrpc<string>("getnewaddress")]);
  assert(txid === bitcoin.Transaction.fromHex(hex).getId(), "txid mismatch");

  console.log(`✓ recovery consensus matrix PASSED (2-of-3, CSV ${CSV}) — txid ${txid.slice(0, 16)}…`);

  // The simple production option is one distinct offline recovery key.
  const singleProfile = { profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1" as const,
    recoveryCsvBlocks: CSV, recoveryThreshold: 1, recoveryPubkeys: [K1] };
  const singleVault = buildRecoveryDraft({
    state, guardianXOnly: xonly(0x42), recoveryProfile: singleProfile,
    outpoint: { txid: "00".repeat(32), vout: 0 }, vaultValueSats: 10_000n,
    destinationScript, minerFeeSats: 1000n, maxMinerFeeSats: 2000n,
  }).vault;
  const singleFundTxid = await wrpc<string>("sendtoaddress", [singleVault.address, 1.0]);
  await rpc("generatetoaddress", [1, await wrpc<string>("getnewaddress")]);
  const singleFundTx = bitcoin.Transaction.fromHex(await provider.getRawTransaction(singleFundTxid));
  const singleVout = singleFundTx.outs.findIndex((o) => o.script.equals(singleVault.scriptPubKey));
  assert(singleVout >= 0, "single-key funding output not found");
  const singleSpend = buildRecoveryDraft({
    state, guardianXOnly: xonly(0x42), recoveryProfile: singleProfile,
    outpoint: { txid: singleFundTxid, vout: singleVout },
    vaultValueSats: BigInt(singleFundTx.outs[singleVout]!.value),
    destinationScript, minerFeeSats: 1000n, maxMinerFeeSats: 2000n,
  });
  addRecoverySignature(singleSpend, K1, signRecoverySighash(singleSpend.sighash, priv(0x51)));
  const singleHex = finalizeRecovery(singleSpend);
  assert((await provider.testMempoolAccept(singleHex)).allowed === false, "single-key recovery must wait for CSV");
  await rpc("generatetoaddress", [CSV, await wrpc<string>("getnewaddress")]);
  const singleAccept = await provider.testMempoolAccept(singleHex);
  assert(singleAccept.allowed === true, `single-key recovery rejected at maturity: ${singleAccept.rejectReason}`);
  const singleTxid = await provider.broadcastTransaction(singleHex);
  await rpc("generatetoaddress", [1, await wrpc<string>("getnewaddress")]);
  assert(singleTxid === bitcoin.Transaction.fromHex(singleHex).getId(), "single-key txid mismatch");
  console.log(`✓ recovery consensus matrix PASSED (1-of-1, CSV ${CSV}) — txid ${singleTxid.slice(0, 16)}…`);
}

main().catch((e) => {
  console.error("recovery-regtest failed:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
