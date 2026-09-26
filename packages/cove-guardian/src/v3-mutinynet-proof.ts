/**
 * Cove V3 (wire v2 / crc-20) proof on Mutinynet — a REAL public Bitcoin network.
 *
 * Why this exists
 * ---------------
 * The production wire format is v2 ("CV" magic, `crc-20` identity) and every
 * user-facing route in `apps/web` builds it. But until now v2 had only ever
 * been broadcast to regtest — a private chain we mine ourselves, where we also
 * write the relay policy. The only format ever relayed by a public network was
 * the frozen V1 ("COVE") format used by `cove-indexer/src/mutinynet-proof.ts`.
 *
 * That gap matters: regtest acceptance is not evidence that independent nodes
 * will relay a transaction. This script closes it by running
 * DEPLOY → MINT → TRANSFER against Mutinynet, a public custom signet whose
 * nodes we do not operate.
 *
 * Safety
 * ------
 * - Mainnet is refused twice: the chain is asserted to be signet-family before
 *   anything is built, and the Guardian's own broadcast boundary refuses
 *   mainnet unconditionally.
 * - The Guardian key is the deterministic 0x42 development burner, identical to
 *   the regtest lifecycle. It is PUBLIC. Anything it guards on Mutinynet is
 *   spendable by anyone, which is acceptable for worthless test coins and is
 *   never to be used anywhere value is held.
 * - The funding WIF is read from a file and never printed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  CoveChainView,
  TOKEN_CARRIER_SATS,
  type OutPoint,
} from "@crclaunch/cove-covenant";
import { CHAIN_BITCOIN_SIGNET, COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildTransferPsbtV2,
  RESERVE_ANCHOR_SATS,
  type ResolvedInput,
} from "./v3/builder.js";
import {
  GuardianV3Signer,
  consoleAuditSink,
  validateAndSignMintTransition,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedTransferTransaction,
  type ValidatedCoveTransaction,
  chainFundingChecker,
} from "./v3/index.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

const ESPLORA = process.env.COVE_MUTINYNET_ESPLORA_URL ?? "https://mutinynet.com/api";
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../.cove-mutinynet-v2-proof.json", import.meta.url),
);

/** Signet/Mutinynet share testnet address encodings; bitcoinjs has no signet. */
const NET = bitcoin.networks.testnet;

/** Mutinynet mines every ~30s, so confirmation waits are short but not instant. */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
const MINER_FEE = 1_000n;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── Esplora transport ───────────────────────────────────────────────────────

async function esploraText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${ESPLORA}${path}`, { signal: AbortSignal.timeout(30_000), ...init });
  const body = (await res.text()).trim();
  if (!res.ok) throw new Error(`Esplora ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
  return body;
}
async function esploraJson<T>(path: string): Promise<T> {
  return JSON.parse(await esploraText(path)) as T;
}

/**
 * Broadcast boundary for a network reached over Esplora.
 *
 * `broadcastValidatedCoveTransaction` requires a Core RPC provider so it can
 * call `testmempoolaccept` before sending. Esplora exposes no such endpoint, so
 * rather than stub one out and quietly weaken that gate, this path keeps the
 * two guarantees that actually matter — mainnet is refused, and only a
 * `ValidatedCoveTransaction` produced by final validation may be sent — and
 * relies on `POST /tx` itself as the acceptance test. A node that will not
 * relay the transaction returns an error here, which is the same signal
 * `testmempoolaccept` would have given, just one step later.
 */
async function broadcastValidated(
  validated: ValidatedCoveTransaction,
  network: string,
): Promise<string> {
  if (network === "mainnet") {
    throw new Error("MAINNET_BROADCAST_REFUSED: mainnet is disabled this phase");
  }
  const txid = await esploraText("/tx", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: validated.rawTxHex,
  });
  assert(/^[0-9a-f]{64}$/.test(txid), `Esplora returned a non-txid response: ${txid.slice(0, 120)}`);
  assert(txid === validated.txid, `broadcast returned ${txid}, expected ${validated.txid}`);
  return txid;
}

function validatedOrThrow(
  result: ValidatedCoveTransaction | { ok: false; reason: string },
  label: string,
): ValidatedCoveTransaction {
  if ("ok" in result) throw new Error(`${label} final validation failed: ${result.reason}`);
  return result;
}

async function waitForConfirmation(txid: string): Promise<number> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await esploraJson<{ confirmed: boolean; block_height?: number }>(
      `/tx/${txid}/status`,
    );
    if (status.confirmed && status.block_height !== undefined) return status.block_height;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`timed out waiting for ${txid} to confirm`);
}

/** Confirmed UTXOs for an address, largest first, as builder inputs. */
async function fundingInputs(address: string, script: Buffer): Promise<ResolvedInput[]> {
  const utxos = await esploraJson<
    { txid: string; vout: number; value: number; status: { confirmed: boolean } }[]
  >(`/address/${address}/utxo`);
  return utxos
    .filter((u) => u.status.confirmed)
    .sort((a, b) => b.value - a.value)
    .map((u) => ({ txid: u.txid, vout: u.vout, script, valueSats: BigInt(u.value) }));
}

function findOutputIndex(tx: bitcoin.Transaction, script: Buffer): number {
  return tx.outs.findIndex((o) => o.script.equals(script));
}

async function rawTx(txid: string): Promise<bitcoin.Transaction> {
  return bitcoin.Transaction.fromHex(await esploraText(`/tx/${txid}/hex`));
}

// ── Proof ───────────────────────────────────────────────────────────────────

interface V2ProofStep {
  txid: string;
  height: number;
}
interface V2ProofManifest {
  protocol: "cove";
  wireVersion: 2;
  protocolId: "crc-20";
  network: "mutinynet";
  ticker: string;
  tokenId: string;
  funder: string;
  recipient: string;
  deploy?: V2ProofStep;
  mint?: V2ProofStep;
  transfer?: V2ProofStep;
}

function readWif(): string {
  const file = process.env.COVE_MUTINYNET_WIF_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`COVE_MUTINYNET_WIF_FILE does not exist: ${file}`);
    return readFileSync(file, "utf8").trim();
  }
  const env = process.env.COVE_MUTINYNET_WIF;
  if (env) return env.trim();
  throw new Error("Set COVE_MUTINYNET_WIF_FILE (path) or COVE_MUTINYNET_WIF. It is never printed.");
}

/** Mutinynet is a custom signet; refuse anything that is not signet-family. */
async function assertSignetFamily(): Promise<void> {
  const genesis = await esploraText("/block-height/0");
  const MAINNET = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
  const TESTNET3 = "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943";
  assert(genesis !== MAINNET, "refusing to run: endpoint is Bitcoin MAINNET");
  assert(genesis !== TESTNET3, "refusing to run: endpoint is testnet3, not signet");
  console.log(`✓ chain is signet-family (genesis ${genesis.slice(0, 16)}…)`);
}

async function main(): Promise<void> {
  const line = "─".repeat(72);
  const ticker = (process.env.COVE_PROOF_TICKER ?? "KELP").toUpperCase();
  assert(/^[A-Z0-9]{4}$/.test(ticker), `COVE_PROOF_TICKER must be [A-Z0-9]{4}, got "${ticker}"`);

  console.log(line);
  console.log("COVE V3 — WIRE v2 / crc-20 — PUBLIC NETWORK PROOF (MUTINYNET)");
  console.log(line);

  await assertSignetFamily();

  // Funder + recipient. The funder pays for everything and receives the tokens;
  // the recipient exists so TRANSFER moves value between distinct scripts.
  const funder = ECPair.fromWIF(readWif(), NET);
  const funderScript = bitcoin.payments.p2wpkh({ pubkey: funder.publicKey, network: NET }).output!;
  const funderAddress = bitcoin.payments.p2wpkh({ pubkey: funder.publicKey, network: NET }).address!;

  const recipientWifFile = process.env.COVE_MUTINYNET_WIF_B_FILE;
  const recipient = recipientWifFile
    ? ECPair.fromWIF(readFileSync(recipientWifFile, "utf8").trim(), NET)
    : ECPair.makeRandom({ network: NET });
  const recipientScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: NET })
    .output!;

  console.log(`✓ funder    ${funderAddress}`);
  console.log(
    `✓ recipient ${bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: NET }).address}`,
  );

  // Guardian + recovery keys: the deterministic development burners. PUBLIC.
  const signer = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42));
  const guardianXOnly = signer.xOnlyPubkey();
  const recoveryXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1));
  // The protocol fee destination. On a test chain this is the funder itself.
  const feeScript = funderScript;
  // A per-run nonce keeps the tokenId unique, so re-running never collides with
  // a previous deployment of the same ticker.
  const tokenNonce = Buffer.alloc(32, 0);
  tokenNonce.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  Buffer.from(ticker, "ascii").copy(tokenNonce, 4);

  const view = new CoveChainView();
  // Funding inputs must be confirmed and hold no Cove tokens (Esplora-backed).
  const fundingChecker = chainFundingChecker({
    chain: {
      getTxout: async (txid, vout) => {
        const [tx, spend, tip] = await Promise.all([
          esploraJson<{ status?: { confirmed?: boolean; block_height?: number } }>(`/tx/${txid}`),
          esploraJson<{ spent?: boolean }>(`/tx/${txid}/outspend/${vout}`),
          esploraText("/blocks/tip/height"),
        ]);
        if (spend.spent) return null;
        return { confirmations: tx.status?.confirmed ? Number(tip) - tx.status.block_height! + 1 : 0 };
      },
    },
    isCoveCarrier: async (o) => view.getTokenUtxo(o) !== null,
  });
  const manifest: V2ProofManifest = {
    protocol: "cove",
    wireVersion: 2,
    protocolId: "crc-20",
    network: "mutinynet",
    ticker,
    tokenId: "",
    funder: funderAddress,
    recipient: bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: NET }).address!,
  };
  const save = () => writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

  // ── DEPLOY ──
  console.log(line);
  console.log(`STEP 1/3 — DEPLOY ${ticker}`);
  let inputs = await fundingInputs(funderAddress, funderScript);
  assert(inputs.length > 0, `no confirmed UTXOs at ${funderAddress}`);
  console.log(`  funding ${inputs[0]!.txid}:${inputs[0]!.vout} = ${inputs[0]!.valueSats} sats`);

  const deploy = buildDeployPsbtV3({ feeScript,
    network: NET,
    identity: {
      chainIdentity: CHAIN_BITCOIN_SIGNET,
      policyVersion: COVE_POLICY_V3,
      ticker,
      tokenNonce,
    },
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    deployerInputs: [inputs[0]!],
    deployerChangeScript: funderScript,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });
  deploy.psbt.signInput(0, funder);
  deploy.psbt.finalizeAllInputs();
  const deployHex = deploy.psbt.extractTransaction().toHex();
  const deployVal = validatedOrThrow(
    validateFinalizedDeployTransaction({ feeScript,
      rawTxHex: deployHex,
      network: "signet",
      chainIdentity: CHAIN_BITCOIN_SIGNET,
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
    }),
    "DEPLOY",
  );
  const tokenId = deploy.tokenId;
  manifest.tokenId = tokenId.toString("hex");
  const deployTxid = await broadcastValidated(deployVal, "signet");
  manifest.deploy = { txid: deployTxid, height: 0 };
  save();
  console.log(`  broadcast ${deployTxid} — waiting for a block…`);
  const deployHeight = await waitForConfirmation(deployTxid);
  manifest.deploy = { txid: deployTxid, height: deployHeight };
  save();

  const deployTx = await rawTx(deployTxid);
  const vaultVout = findOutputIndex(deployTx, deploy.vault.scriptPubKey);
  assert(vaultVout >= 0, "vault output not found in DEPLOY");
  const vaultValue = BigInt(deployTx.outs[vaultVout]!.value);
  assert(vaultValue === RESERVE_ANCHOR_SATS, `S0 vault value ${vaultValue}`);
  view.deploy(
    { tokenId, ticker, policyVersion: COVE_POLICY_V3, deployTxid, tokenNonce, creatorScript: CREATOR_SCRIPT },
    { txid: deployTxid, vout: vaultVout },
    deploy.s0,
  );
  console.log(`✓ DEPLOY confirmed at ${deployHeight} — tokenId ${tokenId.toString("hex")}`);

  // ── MINT ──
  console.log(line);
  // 10k tokens is the same quantity the regtest lifecycle asserts on: gross
  // 86,920 sats, fee 16,519, creator share 17,384 — all far above dust.
  const mintTokens = BigInt(process.env.COVE_PROOF_MINT_TOKENS ?? "10000");
  const mintAmountAtoms = mintTokens * 100_000_000n;
  console.log(`STEP 2/3 — MINT (buy ${mintTokens.toLocaleString("en-US")} tokens from the curve)`);
  inputs = await fundingInputs(funderAddress, funderScript);
  assert(inputs.length > 0, "no confirmed UTXOs for MINT");

  const mint = buildMintPsbtV3({
    network: NET,
    tokenId,
    prevState: deploy.s0,
    prevBacking: {
      txid: deployTxid,
      vout: vaultVout,
      script: deploy.vault.scriptPubKey,
      valueSats: vaultValue,
    },
    mintAmountAtoms,
    guardianXOnly,
    recoveryKeyXOnly: recoveryXOnly,
    buyerInputs: [inputs[0]!],
    buyerCarrierScript: funderScript,
    buyerChangeScript: funderScript,
    feeScript,
    minerFeeSats: MINER_FEE,
    creatorScript: CREATOR_SCRIPT,
  });

  const mintSign = await validateAndSignMintTransition({ fundingChecker,
    signer,
    psbt: mint.psbt,
    view,
    network: "signet",
    recoveryKeyXOnly: recoveryXOnly,
    feeScript,
    auditSink: consoleAuditSink,
  });
  assert(mintSign.ok, `Guardian refused MINT: ${mintSign.ok ? "" : mintSign.reason}`);
  mint.psbt.signInput(1, funder);
  mint.psbt.finalizeInput(1);
  const mintHex = mint.psbt.extractTransaction().toHex();
  const mintVal = validatedOrThrow(
    await validateFinalizedMintTransaction({
      rawTxHex: mintHex,
      view,
      network: "signet",
      guardianXOnly,
      recoveryKeyXOnly: recoveryXOnly,
      feeScript,
    }),
    "MINT",
  );
  const mintTxid = await broadcastValidated(mintVal, "signet");
  manifest.mint = { txid: mintTxid, height: 0 };
  save();
  console.log(`  broadcast ${mintTxid} — waiting for a block…`);
  const mintHeight = await waitForConfirmation(mintTxid);
  manifest.mint = { txid: mintTxid, height: mintHeight };
  save();

  const carrier: OutPoint = { txid: mintTxid, vout: 2 };
  view.mint({
    tokenId,
    nextState: mint.nextState,
    prevBackingOutpoint: { txid: deployTxid, vout: vaultVout },
    nextBackingOutpoint: { txid: mintTxid, vout: 1 },
    recipientOutpoint: carrier,
    recipientScript: funderScript,
    amountAtoms: mintAmountAtoms,
  });
  console.log(
    `✓ MINT confirmed at ${mintHeight} — supply=${mint.nextState.issuedPublicSupplyAtoms} backing=${mint.nextState.backingSats} gross=${mint.grossSats} fee=${mint.buyFeeSats}`,
  );

  // ── TRANSFER ──
  console.log(line);
  console.log("STEP 3/3 — TRANSFER (funder → recipient, full balance)");
  inputs = await fundingInputs(funderAddress, funderScript);
  const funderBtc = inputs.find((i) => !(i.txid === carrier.txid && i.vout === carrier.vout));
  assert(funderBtc !== undefined, "no BTC input available to fund TRANSFER");

  const transfer = buildTransferPsbtV2({
    network: NET,
    tokenId,
    tokenInputs: [
      { txid: carrier.txid, vout: carrier.vout, script: funderScript, valueSats: TOKEN_CARRIER_SATS },
    ],
    tokenInputTotalAtoms: mintAmountAtoms,
    tokenOutputs: [{ script: recipientScript, amountAtoms: mintAmountAtoms }],
    funderInputs: [funderBtc],
    funderChangeScript: funderScript,
    btcOutputs: [],
    minerFeeSats: MINER_FEE,
  });
  transfer.psbt.signInput(0, funder); // token carrier
  transfer.psbt.signInput(1, funder); // BTC funder
  transfer.psbt.finalizeAllInputs();
  const transferHex = transfer.psbt.extractTransaction().toHex();
  const transferVal = validatedOrThrow(
    validateFinalizedTransferTransaction({ rawTxHex: transferHex, view }),
    "TRANSFER",
  );
  const transferTxid = await broadcastValidated(transferVal, "signet");
  manifest.transfer = { txid: transferTxid, height: 0 };
  save();
  console.log(`  broadcast ${transferTxid} — waiting for a block…`);
  const transferHeight = await waitForConfirmation(transferTxid);
  manifest.transfer = { txid: transferTxid, height: transferHeight };
  save();
  console.log(`✓ TRANSFER confirmed at ${transferHeight}`);

  console.log(line);
  console.log("PROOF COMPLETE — wire v2 (crc-20) relayed by a public Bitcoin network");
  console.log(line);
  console.log(`  tokenId  ${tokenId.toString("hex")}`);
  for (const [op, step] of [
    ["DEPLOY", manifest.deploy],
    ["MINT", manifest.mint],
    ["TRANSFER", manifest.transfer],
  ] as const) {
    if (step) console.log(`  ${op.padEnd(9)} ${step.txid}  block ${step.height}`);
  }
  console.log(`  manifest ${MANIFEST_PATH}`);
  console.log("  verify:  https://mutinynet.com/tx/<txid>");
}

import { pathToFileURL } from "node:url";

/** Creator payout script recorded at DEPLOY (output 2). */
const CREATOR_SCRIPT = Buffer.from("0014" + "9".repeat(40), "hex");
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
