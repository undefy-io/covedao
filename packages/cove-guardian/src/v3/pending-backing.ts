import * as bitcoin from "bitcoinjs-lib";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import {
  applyMintV2,
  applyRedeemV2,
  TOKEN_CARRIER_SATS,
  type CoveCanonicalView,
  type CoveStateV2,
  type OutPoint,
  type TokenUtxo,
} from "@crclaunch/cove-covenant";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { OP_MINT, OP_REDEEM } from "@crclaunch/cove-wire";
import { decodeCoveOpReturnTx, unsignedTxDigest } from "./resolve.js";
import { verifyVaultExecutionSignature } from "./signer.js";
import {
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  type FinalizeParams,
} from "./finalize.js";
import { RESERVE_ANCHOR_SATS } from "./builder.js";
import type { SigningJournalStore } from "./journal.js";

export const MAX_PENDING_ANCESTORS = 24;
const key = (outpoint: OutPoint) => `${outpoint.txid}:${outpoint.vout}`;
const prevout = (input: bitcoin.TxInput): OutPoint => ({
  txid: Buffer.from(input.hash).reverse().toString("hex"),
  vout: input.index,
});

export interface PendingBackingParams extends Omit<FinalizeParams, "rawTxHex" | "prevouts"> {
  target: OutPoint;
  tokenId: Buffer;
  provider: CoreRpcProvider;
  journal: SigningJournalStore;
  requestedInputs?: OutPoint[];
  assertCurrent: () => Promise<void>;
}

export async function verifyPendingBackingView(
  params: PendingBackingParams,
): Promise<CoveCanonicalView> {
  const anchor = params.view.getBackingOutpoint(params.tokenId);
  let state = params.view.getCurrentBackingState(params.tokenId);
  if (!anchor || !state) throw new Error("PENDING_UNKNOWN_TOKEN");
  if (params.target.vout !== 1) throw new Error("PENDING_WRONG_VAULT_OUTPUT");
  if (key(anchor) !== key(params.target) && !params.journal.readSigned)
    throw new Error("PENDING_SIGNING_RECORD_REQUIRED");
  const tip = await params.provider.getBlockchainInfo();
  const expectedChain =
    params.network === "mainnet" ? "main" : params.network === "testnet" ? "test" : params.network;
  if (tip.chain !== expectedChain) throw new Error("PENDING_WRONG_NETWORK");
  const baseVault = buildBackingVaultV3({
    state,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network:
      params.network === "mainnet"
        ? bitcoin.networks.bitcoin
        : params.network === "regtest"
          ? bitcoin.networks.regtest
          : bitcoin.networks.testnet,
  });
  const base = await params.provider.getTxout(anchor.txid, anchor.vout, false);
  if (
    !base ||
    base.bestBlockHash !== tip.bestBlockHash ||
    base.scriptPubKeyHex !== baseVault.scriptPubKey.toString("hex") ||
    base.valueSats !== RESERVE_ANCHOR_SATS + state.backingSats
  ) {
    throw new Error("PENDING_CANONICAL_VAULT_UNAVAILABLE");
  }
  const ancestors: bitcoin.Transaction[] = [];
  const seen = new Set<string>();
  let cursor = params.target;
  let totalBytes = 0;
  while (key(cursor) !== key(anchor)) {
    if (ancestors.length >= MAX_PENDING_ANCESTORS || seen.has(cursor.txid) || cursor.vout !== 1)
      throw new Error("PENDING_ANCESTRY_LIMIT");
    seen.add(cursor.txid);
    const observation = await params.provider.observeTransaction(cursor.txid, {
      retry: false,
      signal: AbortSignal.timeout(5_000),
    });
    if (observation.state !== "mempool") throw new Error("PENDING_PARENT_UNAVAILABLE");
    const raw = await params.provider.getRawTransaction(cursor.txid);
    totalBytes += raw.length / 2;
    if (raw.length > 200_000 || totalBytes > 1_000_000) throw new Error("PENDING_ANCESTRY_LIMIT");
    const tx = bitcoin.Transaction.fromHex(raw);
    if (tx.getId() !== cursor.txid || !tx.ins[0]) throw new Error("PENDING_TRANSACTION_MISMATCH");
    const wire = decodeCoveOpReturnTx(tx);
    if ((wire.op !== OP_MINT && wire.op !== OP_REDEEM) || !wire.tokenId.equals(params.tokenId))
      throw new Error("PENDING_TOKEN_MISMATCH");
    ancestors.push(tx);
    cursor = prevout(tx.ins[0]);
  }

  const finalView = await replayPendingBackingAncestry(params, ancestors.reverse());
  state = finalView.getCurrentBackingState(params.tokenId)!;
  const targetVault = buildBackingVaultV3({
    state,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network:
      params.network === "mainnet"
        ? bitcoin.networks.bitcoin
        : params.network === "regtest"
          ? bitcoin.networks.regtest
          : bitcoin.networks.testnet,
  });
  // Confirmed inputs may already have a competing mempool spend. A pending
  // input may likewise be spent, but must belong to our fully verified ancestry.
  const observedOutput =
    key(params.target) === key(anchor)
      ? base
      : await params.provider.getTxout(params.target.txid, params.target.vout);
  const output =
    observedOutput ??
    (ancestors.length
      ? {
          bestBlockHash: tip.bestBlockHash,
          scriptPubKeyHex: ancestors[ancestors.length - 1]!.outs[1]!.script.toString("hex"),
          valueSats: BigInt(ancestors[ancestors.length - 1]!.outs[1]!.value),
        }
      : null);
  if (
    !output ||
    output.bestBlockHash !== tip.bestBlockHash ||
    output.scriptPubKeyHex !== targetVault.scriptPubKey.toString("hex") ||
    output.valueSats !== RESERVE_ANCHOR_SATS + state.backingSats
  ) {
    throw new Error("PENDING_VAULT_UNAVAILABLE");
  }
  for (const input of params.requestedInputs ?? []) {
    const token = finalView.getTokenUtxo(input);
    if (!token) continue;
    const pendingToken = ancestors.some((tx) => tx.getId() === input.txid) ? token : undefined;
    const observedCarrier = await params.provider.getTxout(
      input.txid,
      input.vout,
      pendingToken ? undefined : false,
    );
    const carrier =
      observedCarrier ??
      (pendingToken
        ? {
            bestBlockHash: tip.bestBlockHash,
            scriptPubKeyHex: pendingToken.scriptPubKey.toString("hex"),
            valueSats: TOKEN_CARRIER_SATS,
          }
        : null);
    if (
      !carrier ||
      carrier.bestBlockHash !== tip.bestBlockHash ||
      carrier.scriptPubKeyHex !== token.scriptPubKey.toString("hex") ||
      carrier.valueSats !== TOKEN_CARRIER_SATS
    ) {
      throw new Error("PENDING_TOKEN_INPUT_UNAVAILABLE");
    }
  }
  for (const tx of ancestors) {
    if (
      (
        await params.provider.observeTransaction(tx.getId(), {
          retry: false,
          signal: AbortSignal.timeout(5_000),
        })
      ).state !== "mempool"
    ) {
      throw new Error("PENDING_PARENT_UNAVAILABLE");
    }
  }
  const latest = await params.provider.getBlockchainInfo();
  if (latest.bestBlockHash !== tip.bestBlockHash || latest.blocks !== tip.blocks)
    throw new Error("PENDING_CHAIN_CHANGED");
  await params.assertCurrent();
  return finalView;
}

export async function replayPendingBackingAncestry(
  params: Omit<PendingBackingParams, "target" | "provider" | "requestedInputs" | "assertCurrent">,
  transactions: readonly bitcoin.Transaction[],
): Promise<CoveCanonicalView> {
  const anchor = params.view.getBackingOutpoint(params.tokenId);
  let state = params.view.getCurrentBackingState(params.tokenId);
  if (!anchor || !state || transactions.length > MAX_PENDING_ANCESTORS)
    throw new Error("PENDING_UNKNOWN_TOKEN");
  const tokens = new Map<string, TokenUtxo>();
  const spent = new Set<string>();
  let backing = anchor;
  const overlay = (): CoveCanonicalView => {
    const currentState = state!;
    const currentBacking = backing;
    const matches = (id: Buffer) => id.equals(params.tokenId);
    return {
      cursorHeight: params.view.cursorHeight,
      getBackingOutpoint: (id) =>
        matches(id) ? currentBacking : params.view.getBackingOutpoint(id),
      getCurrentBackingState: (id) =>
        matches(id) ? currentState : params.view.getCurrentBackingState(id),
      getBackingStateByOutpoint: (outpoint) =>
        key(outpoint) === key(currentBacking)
          ? currentState
          : params.view.getBackingStateByOutpoint(outpoint),
      getTokenUtxo: (outpoint) =>
        spent.has(key(outpoint))
          ? null
          : (tokens.get(key(outpoint)) ?? params.view.getTokenUtxo(outpoint)),
      getTokenCreatorScript: (id) => params.view.getTokenCreatorScript?.(id) ?? null,
    };
  };
  for (const tx of transactions) {
    const wire = decodeCoveOpReturnTx(tx);
    if (wire.op !== OP_MINT && wire.op !== OP_REDEEM) throw new Error("PENDING_WRONG_OPERATION");
    const unsigned = tx.clone();
    for (const input of unsigned.ins) {
      input.script = Buffer.alloc(0);
      input.witness = [];
    }
    const digest = unsigned.getId();
    const saved = await params.journal.readSigned!({
      network: params.network,
      backingTxid: backing.txid,
      backingVout: backing.vout,
      unsignedTxDigest: digest,
    });
    if (!saved) throw new Error("PENDING_SIGNING_RECORD_REQUIRED");
    const signed = bitcoin.Psbt.fromBase64(saved.psbtBase64);
    if (unsignedTxDigest(signed) !== digest || signed.data.inputs.length !== tx.ins.length)
      throw new Error("PENDING_SIGNING_RECORD_MISMATCH");
    const prevouts = new Map<string, { script: Buffer; valueSats: bigint }>();
    for (let index = 0; index < tx.ins.length; index++) {
      const output = signed.data.inputs[index]?.witnessUtxo;
      if (!output) throw new Error("PENDING_PREVOUT_UNAVAILABLE");
      prevouts.set(key(prevout(tx.ins[index]!)), {
        script: Buffer.from(output.script),
        valueSats: BigInt(output.value),
      });
    }
    const vault = buildBackingVaultV3({
      state,
      guardianXOnly: params.guardianXOnly,
      recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
      network:
        params.network === "mainnet"
          ? bitcoin.networks.bitcoin
          : params.network === "regtest"
            ? bitcoin.networks.regtest
            : bitcoin.networks.testnet,
    });
    const leaf = wire.op === OP_MINT ? vault.mintLeaf : vault.redeemLeaf;
    const control = wire.op === OP_MINT ? vault.mintControlBlock : vault.redeemControlBlock;
    const witness = tx.ins[0]!.witness;
    if (
      witness.length !== 4 ||
      witness[0]!.length !== 64 ||
      !witness[1]!.equals(leaf.script.subarray(1, 33)) ||
      !witness[2]!.equals(leaf.script) ||
      !witness[3]!.equals(control)
    )
      throw new Error("PENDING_VAULT_WITNESS_MISMATCH");
    verifyVaultExecutionSignature(signed, 0, leaf, witness[0]!, params.guardianXOnly);
    const validation = await (
      wire.op === OP_MINT ? validateFinalizedMintTransaction : validateFinalizedRedeemTransaction
    )({
      ...params,
      rawTxHex: tx.toHex(),
      view: overlay(),
      prevouts,
    });
    if (!("rawTxHex" in validation))
      throw new Error(`PENDING_PARENT_REJECTED: ${validation.reason}`);
    const next: CoveStateV2 =
      wire.op === OP_MINT
        ? applyMintV2(state, wire.amount).nextState
        : applyRedeemV2(state, wire.redeemAmount).nextState;
    for (const input of tx.ins) spent.add(key(prevout(input)));
    const allocations =
      wire.op === OP_MINT
        ? [{ vout: wire.recipientVout, amount: wire.amount }]
        : wire.changeAllocations;
    for (const allocation of allocations) {
      const outpoint = { txid: tx.getId(), vout: allocation.vout };
      tokens.set(key(outpoint), {
        outpoint,
        tokenId: params.tokenId,
        amountAtoms: allocation.amount,
        scriptPubKey: tx.outs[allocation.vout]!.script,
      });
    }
    state = next;
    backing = { txid: tx.getId(), vout: 1 };
  }
  return overlay();
}
