import { Transaction } from "bitcoinjs-lib";
import { crc20AssetId, parseCrc20Transaction, type BitcoinNetwork, type TxOutput } from "@crclaunch/crc20-base";
import { applyBuy, applySell, createCurveState, quoteBuy, quoteSell, type CurveState } from "@crclaunch/crc20-curve";
import { dustThreshold } from "@crclaunch/cove-economics";
import { applyRegisteredCoveDeploy, validateCoveOperation, type RegisteredCoveDeployment } from "./cove.js";
import { createLedger } from "./index.js";

const ATOMS_PER_TOKEN = 100_000_000n;

export type CoveObservation = Readonly<{
  network: BitcoinNetwork;
  rawHex: string;
  parentRawHexes: readonly string[];
  blockHash: string;
  blockTxids: readonly string[];
  height: number;
  index: number;
}>;

export type CoveAsset = Readonly<{
  ticker: string;
  status: "live" | "broken";
  vaultScriptHex: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  curve: CurveState;
  balances: Record<string, string>;
}>;

export type CoveLedgerState = Readonly<{
  assets: Record<string, CoveAsset>;
  appliedTxids: Record<string, true>;
  lastPosition: Record<string, { height: number; index: number }>;
}>;

export type CoveReplayResult = Readonly<{
  status: "applied" | "ignored" | "invalid" | "broken";
  reason: string;
  state: CoveLedgerState;
}>;

type VerifiedInput = { outpoint: string; valueSats: number; scriptHex: string };

export function createCoveLedger(): CoveLedgerState {
  return { assets: {}, appliedTxids: {}, lastPosition: {} };
}

function outcome(state: CoveLedgerState, status: CoveReplayResult["status"], reason: string): CoveReplayResult {
  return { state, status, reason };
}

function outputsOf(tx: Transaction): TxOutput[] {
  return tx.outs.map((output) => ({ valueSats: output.value, scriptHex: output.script.toString("hex") }));
}

function readInputs(tx: Transaction, parents: readonly string[]): VerifiedInput[] | undefined {
  if (parents.length !== tx.ins.length) return undefined;
  const result: VerifiedInput[] = [];
  for (let index = 0; index < tx.ins.length; index++) {
    const input = tx.ins[index]!;
    let parent: Transaction;
    try { parent = Transaction.fromHex(parents[index]!); } catch { return undefined; }
    const expectedTxid = Buffer.from(input.hash).reverse().toString("hex");
    if (parent.getId() !== expectedTxid) return undefined;
    const spent = parent.outs[input.index];
    if (!spent || !Number.isSafeInteger(spent.value) || spent.value < 0) return undefined;
    result.push({ outpoint: `${expectedTxid}:${input.index}`, valueSats: spent.value, scriptHex: spent.script.toString("hex") });
  }
  return result;
}

function copy(state: CoveLedgerState): CoveLedgerState {
  return { assets: { ...state.assets }, appliedTxids: { ...state.appliedTxids }, lastPosition: { ...state.lastPosition } };
}

function stamped(state: CoveLedgerState, observation: CoveObservation, txid: string): CoveLedgerState {
  const next = copy(state);
  next.appliedTxids[crc20AssetId(observation.network, txid)] = true;
  next.lastPosition[observation.network] = { height: observation.height, index: observation.index };
  return next;
}

function breakVault(state: CoveLedgerState, observation: CoveObservation, txid: string, assetIds: readonly string[], reason: string): CoveReplayResult {
  const next = stamped(state, observation, txid);
  for (const assetId of assetIds) next.assets[assetId] = { ...state.assets[assetId]!, status: "broken" };
  return outcome(next, "broken", reason);
}

function exact(output: TxOutput | undefined, sats: bigint, scriptHex: string): boolean {
  return !!output && BigInt(output.valueSats) === sats && output.scriptHex.toLowerCase() === scriptHex.toLowerCase();
}

function ordinaryChange(outputs: readonly TxOutput[], firstChange: number, payerScripts: readonly string[]): boolean {
  if (outputs.length === firstChange) return true;
  if (outputs.length !== firstChange + 1) return false;
  const change = outputs[firstChange]!;
  return payerScripts.some((script) => change.scriptHex.toLowerCase() === script.toLowerCase()) &&
    BigInt(change.valueSats) >= dustThreshold(Buffer.from(change.scriptHex, "hex"));
}

function spendableScript(scriptHex: string): boolean {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptHex)) return false;
  const script = Buffer.from(scriptHex, "hex");
  return (script.length === 22 && script[0] === 0 && script[1] === 0x14) ||
    (script.length === 34 && script[0] === 0 && script[1] === 0x20) ||
    (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) ||
    (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) ||
    (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87);
}

function balance(asset: CoveAsset, scriptHex: string): bigint {
  return BigInt(asset.balances[scriptHex.toLowerCase()] ?? "0");
}

function putBalance(balances: Record<string, string>, scriptHex: string, value: bigint): void {
  balances[scriptHex.toLowerCase()] = value.toString();
}

function validBalances(asset: CoveAsset): boolean {
  let total = 0n;
  for (const [scriptHex, atoms] of Object.entries(asset.balances)) {
    if (!/^(?:[0-9a-f]{2})+$/.test(scriptHex) || !/^(0|[1-9][0-9]*)$/.test(atoms)) return false;
    total += BigInt(atoms);
  }
  return total === asset.curve.mintedAtoms &&
    BigInt(asset.balances[asset.vaultScriptHex] ?? "0") === asset.curve.vaultAtoms;
}

export function applyCoveConfirmed(
  state: CoveLedgerState,
  observation: CoveObservation,
  registrations: readonly RegisteredCoveDeployment[],
): CoveReplayResult {
  let tx: Transaction;
  try { tx = Transaction.fromHex(observation.rawHex); } catch { return outcome(state, "invalid", "invalid raw transaction"); }
  const txid = tx.getId();
  if (!/^[0-9a-f]{64}$/.test(observation.blockHash) ||
    observation.blockTxids[observation.index] !== txid) {
    return outcome(state, "invalid", "raw transaction does not match observed block position");
  }
  if (!Number.isSafeInteger(observation.height) || observation.height < 0 ||
    !Number.isSafeInteger(observation.index) || observation.index < 0) {
    return outcome(state, "invalid", "invalid block position");
  }
  const position = state.lastPosition[observation.network];
  if (position && (observation.height < position.height ||
    (observation.height === position.height && observation.index <= position.index))) {
    return outcome(state, "invalid", "out-of-order transaction");
  }
  const txKey = crc20AssetId(observation.network, txid);
  if (state.appliedTxids[txKey]) return outcome(state, "invalid", "duplicate transaction");
  const inputs = readInputs(tx, observation.parentRawHexes);
  if (!inputs) return outcome(state, "invalid", "parent transaction does not match raw input outpoint");
  const outputs = outputsOf(tx);
  const inputSats = inputs.reduce((sum, input) => sum + BigInt(input.valueSats), 0n);
  const outputSats = outputs.reduce((sum, output) => sum + BigInt(output.valueSats), 0n);
  if (inputSats < outputSats) return outcome(state, "invalid", "transaction outputs exceed verified inputs");

  const spentAssetIds = Object.keys(state.assets).filter((assetId) =>
    state.assets[assetId]?.status === "live" && inputs.some((input) => input.outpoint === state.assets[assetId]?.curve.vaultOutpoint));
  const spentAssetId = spentAssetIds[0];
  const parsed = parseCrc20Transaction(outputs);
  if (parsed.status !== "valid") {
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "confirmed invalid vault spend");
    return outcome(state, parsed.status === "none" ? "ignored" : "invalid", parsed.status === "none" ? "no CRC marker" : parsed.reason);
  }
  if (parsed.envelope.kind === "deploy") {
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "vault spent in deploy transaction");
    const registered = applyRegisteredCoveDeploy(createLedger(), {
      network: observation.network, txid, height: observation.height, index: observation.index, outputs,
    }, registrations);
    if (registered.status !== "applied") return outcome(state, registered.status === "ignored" ? "ignored" : "invalid", registered.reason);
    const launch = registrations.find((entry) => entry.network === observation.network && entry.txid === txid)!;
    const next = stamped(state, observation, txid);
    const id = crc20AssetId(observation.network, txid);
    if (next.assets[id]) return outcome(state, "invalid", "duplicate Cove deployment");
    next.assets[id] = {
      ticker: parsed.envelope.ticker, status: "live",
      vaultScriptHex: launch.vaultScriptHex.toLowerCase(),
      creatorScriptHex: launch.creatorScriptHex.toLowerCase(),
      protocolScriptHex: launch.protocolScriptHex.toLowerCase(),
      curve: createCurveState(`${txid}:1`, BigInt(launch.vaultAnchorSats)),
      balances: { [launch.vaultScriptHex.toLowerCase()]: "0" },
    };
    return outcome(next, "applied", "registered Cove deployment");
  }

  const markerId = parsed.envelope.payload.id;
  if (typeof markerId !== "string" || !/^[0-9a-f]{64}$/.test(markerId)) {
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "vault spent with missing asset id");
    return outcome(state, "invalid", "missing Cove deployment id");
  }
  const assetId = crc20AssetId(observation.network, markerId);
  const asset = state.assets[assetId];
  if (!asset) {
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "vault spent for unknown asset id");
    return outcome(state, "ignored", "external deployment");
  }
  if (asset.status !== "live") return outcome(state, "invalid", "asset is unavailable");
  if (!validBalances(asset)) return outcome(state, "invalid", "stored Cove token balances are inconsistent");
  const formatted = validateCoveOperation(outputs, { txid: markerId, ticker: asset.ticker });
  if (formatted.status !== "valid") {
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, formatted.reason);
    return outcome(state, "invalid", formatted.reason);
  }
  if (spentAssetId && (spentAssetIds.length !== 1 || spentAssetId !== assetId)) return breakVault(state, observation, txid, spentAssetIds, "wrong or multiple asset vaults spent");
  const amountAtoms = formatted.amountAtoms;
  const recipientScript = outputs[1]!.scriptHex.toLowerCase();
  const vaultIsInputZero = inputs[0]?.outpoint === asset.curve.vaultOutpoint;
  if (spentAssetId && !vaultIsInputZero) return breakVault(state, observation, txid, spentAssetIds, "vault must be input zero");
  const next = stamped(state, observation, txid);
  const balances = { ...asset.balances };
  let curve = asset.curve;
  try {
    if (vaultIsInputZero) {
      if (inputs[0]!.scriptHex.toLowerCase() !== asset.vaultScriptHex || BigInt(inputs[0]!.valueSats) !== curve.vaultSats) {
        throw new Error("vault prevout does not match current state");
      }
      const payer = inputs[1];
      if (!payer) throw new Error("missing buyer or seller input");
      if (formatted.kind === "mint" || recipientScript !== asset.vaultScriptHex) {
        const quote = quoteBuy(curve, amountAtoms / ATOMS_PER_TOKEN);
        if (formatted.kind !== quote.operation || outputs.length < 5 || outputs.length > 6 ||
          !exact(outputs[2], curve.vaultSats + quote.grossSats, asset.vaultScriptHex) ||
          !exact(outputs[3], quote.protocolFeeSats, asset.protocolScriptHex) ||
          !exact(outputs[4], quote.creatorFeeSats, asset.creatorScriptHex) ||
          !ordinaryChange(outputs, 5, [payer.scriptHex])) throw new Error("buy backing, fee, or recipient layout mismatch");
        curve = applyBuy(curve, {
          amountAtoms, previousVaultOutpoint: curve.vaultOutpoint, nextVaultOutpoint: `${txid}:2`,
          nextVaultSats: BigInt(outputs[2]!.valueSats), protocolFeeSats: BigInt(outputs[3]!.valueSats),
          creatorFeeSats: BigInt(outputs[4]!.valueSats),
        });
        if (quote.operation === "transfer") {
          const inventory = balance(asset, asset.vaultScriptHex);
          if (inventory < amountAtoms) throw new Error("vault token inventory is insufficient");
          putBalance(balances, asset.vaultScriptHex, inventory - amountAtoms);
        }
        putBalance(balances, recipientScript, balance(asset, recipientScript) + amountAtoms);
      } else {
        const payoutScript = outputs[2]?.scriptHex.toLowerCase();
        const sellerScripts = inputs.slice(1).map((input) => input.scriptHex);
        if (formatted.kind !== "transfer" || outputs.length < 4 || outputs.length > 5 ||
          !payoutScript || !spendableScript(payoutScript) || payoutScript === asset.vaultScriptHex ||
          !sellerScripts.some((script) => script.toLowerCase() === payoutScript)) throw new Error("seller payout recipient mismatch");
        const dust = dustThreshold(Buffer.from(payoutScript, "hex"));
        const quote = quoteSell(curve, amountAtoms / ATOMS_PER_TOKEN, dust);
        if (!exact(outputs[1], curve.vaultSats - quote.grossSats, asset.vaultScriptHex) ||
          !exact(outputs[2], quote.sellerPayoutSats, payoutScript) ||
          !exact(outputs[3], quote.protocolFeeSats, asset.protocolScriptHex) ||
          !ordinaryChange(outputs, 4, sellerScripts)) throw new Error("sell backing, fee, or payout mismatch");
        if (balance(asset, payer.scriptHex) < amountAtoms) throw new Error("seller token balance is insufficient");
        curve = applySell(curve, {
          amountAtoms, previousVaultOutpoint: curve.vaultOutpoint, nextVaultOutpoint: `${txid}:1`,
          nextVaultSats: BigInt(outputs[1]!.valueSats), protocolFeeSats: BigInt(outputs[3]!.valueSats),
          sellerPayoutSats: BigInt(outputs[2]!.valueSats), walletTopUpSats: quote.walletTopUpSats,
          payoutDustSats: dust,
        });
        putBalance(balances, payer.scriptHex, balance(asset, payer.scriptHex) - amountAtoms);
        putBalance(balances, asset.vaultScriptHex, balance(asset, asset.vaultScriptHex) + amountAtoms);
      }
    } else {
      if (formatted.kind !== "transfer" || !inputs[0] || inputs[0].scriptHex.toLowerCase() === asset.vaultScriptHex) {
        throw new Error("peer transfer requires sender input zero");
      }
      if (recipientScript === asset.vaultScriptHex) {
        throw new Error("vault inventory requires a validated vault trade");
      }
      const sender = inputs[0].scriptHex;
      if (balance(asset, sender) < amountAtoms) throw new Error("sender token balance is insufficient");
      if (sender.toLowerCase() !== recipientScript) {
        putBalance(balances, sender, balance(asset, sender) - amountAtoms);
        putBalance(balances, recipientScript, balance(asset, recipientScript) + amountAtoms);
      }
    }
    if (BigInt(balances[asset.vaultScriptHex] ?? "0") !== curve.vaultAtoms) {
      throw new Error("vault token inventory does not match curve state");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid Cove transaction";
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, reason);
    return outcome(state, "invalid", reason);
  }
  const nextAsset = { ...asset, curve, balances };
  if (!validBalances(nextAsset)) {
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "Cove token balances do not conserve supply");
    return outcome(state, "invalid", "Cove token balances do not conserve supply");
  }
  next.assets[assetId] = nextAsset;
  return outcome(next, "applied", `${formatted.kind} indexed`);
}
