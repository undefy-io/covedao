import { address, networks } from "bitcoinjs-lib";
import {
  crc20AssetId,
  parseCrc20Transaction,
  type BitcoinNetwork,
  type TxOutput,
} from "@crclaunch/crc20-base";

export type LedgerTransaction = {
  network: BitcoinNetwork;
  txid: string;
  height: number;
  index: number;
  outputs: readonly TxOutput[];
};

export type LedgerDecision = {
  assetId?: string;
  amountAtoms?: string;
  recipientAddress?: string;
  senderAddress?: string;
};

export type LedgerState = {
  assets: Record<string, { ticker: string; supplyAtoms: string }>;
  balances: Record<string, Record<string, string>>;
  appliedTxids: Record<string, true>;
  lastPosition: Record<string, { height: number; index: number }>;
};

export type ApplyResult = {
  status: "applied" | "unresolved" | "invalid" | "ignored";
  reason: string;
  state: LedgerState;
};

export function createLedger(): LedgerState {
  return { assets: {}, balances: {}, appliedTxids: {}, lastPosition: {} };
}

export function balanceOf(state: LedgerState, assetId: string, owner: string): bigint {
  return BigInt(state.balances[assetId]?.[owner] ?? "0");
}

function result(state: LedgerState, status: ApplyResult["status"], reason: string): ApplyResult {
  return { state, status, reason };
}

function positiveAtoms(input: string | undefined): bigint | undefined {
  if (!input || !/^[1-9][0-9]*$/.test(input)) return undefined;
  return BigInt(input);
}

function bitcoinNetwork(network: BitcoinNetwork) {
  return network === "mainnet"
    ? networks.bitcoin
    : network === "regtest"
      ? networks.regtest
      : networks.testnet;
}

function outputAddress(output: TxOutput | undefined, network: BitcoinNetwork): string | undefined {
  if (!output) return undefined;
  try {
    const script = Buffer.from(output.scriptHex, "hex");
    const chain = bitcoinNetwork(network);
    if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
      return address.toBech32(script.subarray(2), 1, chain.bech32);
    }
    return address.fromOutputScript(script, chain);
  } catch {
    return undefined;
  }
}

function copyState(state: LedgerState): LedgerState {
  return {
    assets: { ...state.assets },
    balances: { ...state.balances },
    appliedTxids: { ...state.appliedTxids },
    lastPosition: { ...state.lastPosition },
  };
}

export function applyTransaction(
  state: LedgerState,
  transaction: LedgerTransaction,
  decision: LedgerDecision = {},
): ApplyResult {
  let selfAssetId: string;
  try {
    selfAssetId = crc20AssetId(transaction.network, transaction.txid);
  } catch {
    return result(state, "invalid", "invalid network or transaction id");
  }
  if (
    !Number.isSafeInteger(transaction.height) ||
    transaction.height < 0 ||
    !Number.isSafeInteger(transaction.index) ||
    transaction.index < 0
  ) {
    return result(state, "invalid", "invalid chain position");
  }
  const txKey = selfAssetId;
  if (state.appliedTxids[txKey]) return result(state, "invalid", "duplicate transaction");
  const last = state.lastPosition[transaction.network];
  if (
    last &&
    (transaction.height < last.height ||
      (transaction.height === last.height && transaction.index <= last.index))
  ) {
    return result(state, "invalid", "transaction is out of block order");
  }
  const parsed = parseCrc20Transaction(transaction.outputs);
  if (parsed.status === "none") return result(state, "ignored", "no CRC-20 operation");
  if (parsed.status === "invalid") return result(state, "invalid", parsed.reason);
  const envelope = parsed.envelope;
  if (envelope.kind === "deploy") {
    if (state.assets[selfAssetId]) return result(state, "invalid", "duplicate deployment");
    const next = copyState(state);
    next.assets[selfAssetId] = { ticker: envelope.ticker, supplyAtoms: "0" };
    next.balances[selfAssetId] = {};
    next.appliedTxids[txKey] = true;
    next.lastPosition[transaction.network] = {
      height: transaction.height,
      index: transaction.index,
    };
    return result(next, "applied", "deployment indexed");
  }
  if (!decision.assetId)
    return result(state, "unresolved", "asset deployment identity is not resolved");
  const asset = state.assets[decision.assetId];
  if (!asset) return result(state, "invalid", "unknown deployment");
  if (!decision.assetId.startsWith(`${transaction.network}:`) || asset.ticker !== envelope.ticker) {
    return result(state, "invalid", "asset network or ticker mismatch");
  }
  const next = copyState(state);
  next.balances[decision.assetId] = { ...state.balances[decision.assetId] };
  const account = next.balances[decision.assetId];
  if (!account) return result(state, "invalid", "missing asset accounts");
  if (envelope.kind === "mint") {
    const amount = positiveAtoms(decision.amountAtoms);
    if (!amount || !decision.recipientAddress) {
      return result(state, "unresolved", "mint amount and beneficiary require policy verification");
    }
    if (
      !transaction.outputs.some(
        (output) => outputAddress(output, transaction.network) === decision.recipientAddress,
      )
    ) {
      return result(state, "invalid", "mint beneficiary is not a transaction output");
    }
    account[decision.recipientAddress] = (
      balanceOf(state, decision.assetId, decision.recipientAddress) + amount
    ).toString();
    next.assets[decision.assetId] = {
      ...asset,
      supplyAtoms: (BigInt(asset.supplyAtoms) + amount).toString(),
    };
  } else {
    if (!decision.senderAddress)
      return result(state, "unresolved", "transfer sender requires verified prevout provenance");
    const recipientAddress = outputAddress(
      transaction.outputs[envelope.recipientVout],
      transaction.network,
    );
    if (!recipientAddress)
      return result(state, "invalid", "recipient output has no supported address");
    const amount = BigInt(envelope.amountAtoms);
    const prior = balanceOf(state, decision.assetId, decision.senderAddress);
    if (prior < amount) return result(state, "invalid", "sender balance is insufficient");
    if (decision.senderAddress !== recipientAddress) {
      account[decision.senderAddress] = (prior - amount).toString();
      account[recipientAddress] = (
        balanceOf(state, decision.assetId, recipientAddress) + amount
      ).toString();
    }
  }
  next.appliedTxids[txKey] = true;
  next.lastPosition[transaction.network] = { height: transaction.height, index: transaction.index };
  return result(next, "applied", `${envelope.kind} indexed`);
}
