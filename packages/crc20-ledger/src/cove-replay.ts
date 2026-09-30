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
  protocolVersion?: 1 | 2;
  tokenUtxos?: Record<string, { scriptHex: string; atoms: string }>;
  burnedAtoms?: string;
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
  if (asset.protocolVersion === 2) {
    if (!asset.tokenUtxos || !/^(0|[1-9][0-9]*)$/.test(asset.burnedAtoms ?? "")) return false;
    const derived: Record<string, bigint> = {};
    let total = BigInt(asset.burnedAtoms!);
    for (const [outpoint, coin] of Object.entries(asset.tokenUtxos)) {
      if (!/^[0-9a-f]{64}:[0-9]+$/.test(outpoint) || !spendableScript(coin.scriptHex) ||
        !/^[1-9][0-9]*$/.test(coin.atoms)) return false;
      const atoms = BigInt(coin.atoms);
      total += atoms;
      derived[coin.scriptHex.toLowerCase()] = (derived[coin.scriptHex.toLowerCase()] ?? 0n) + atoms;
    }
    if (total !== asset.curve.mintedAtoms) return false;
    if (asset.status === "live" &&
      BigInt(asset.tokenUtxos[asset.curve.vaultOutpoint]?.atoms ?? "0") !== asset.curve.vaultAtoms) return false;
    for (const [scriptHex, amount] of Object.entries(asset.balances)) {
      if (!/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) !== (derived[scriptHex.toLowerCase()] ?? 0n)) return false;
    }
    return Object.keys(derived).every((scriptHex) => BigInt(asset.balances[scriptHex] ?? "-1") === derived[scriptHex]);
  }
  let total = 0n;
  for (const [scriptHex, atoms] of Object.entries(asset.balances)) {
    if (!/^(?:[0-9a-f]{2})+$/.test(scriptHex) || !/^(0|[1-9][0-9]*)$/.test(atoms)) return false;
    total += BigInt(atoms);
  }
  return total === asset.curve.mintedAtoms &&
    BigInt(asset.balances[asset.vaultScriptHex] ?? "0") === asset.curve.vaultAtoms;
}

function derivedBalances(coins: Record<string, { scriptHex: string; atoms: string }>, prior: Record<string, string>): Record<string, string> {
  const result = Object.fromEntries(Object.keys(prior).map((key) => [key, "0"]));
  for (const coin of Object.values(coins)) {
    const scriptHex = coin.scriptHex.toLowerCase();
    result[scriptHex] = (BigInt(result[scriptHex] ?? "0") + BigInt(coin.atoms)).toString();
  }
  return result;
}

function spentV2Assets(state: CoveLedgerState, inputs: readonly VerifiedInput[]): string[] {
  return Object.keys(state.assets).filter((id) => {
    const asset = state.assets[id]!;
    return asset.protocolVersion === 2 && inputs.some((input) => !!asset.tokenUtxos?.[input.outpoint]);
  });
}

function burnV2Inputs(state: CoveLedgerState, observation: CoveObservation, txid: string,
  inputs: readonly VerifiedInput[], reason: string): CoveReplayResult {
  const next = stamped(state, observation, txid);
  let broken = false;
  for (const assetId of Object.keys(state.assets)) {
    const asset = state.assets[assetId]!;
    if (asset.protocolVersion !== 2) {
      if (asset.status === "live" && inputs.some((input) => input.outpoint === asset.curve.vaultOutpoint)) {
        next.assets[assetId] = { ...asset, status: "broken" };
        broken = true;
      }
      continue;
    }
    const coins = { ...asset.tokenUtxos };
    let burned = BigInt(asset.burnedAtoms ?? "0");
    for (const input of inputs) {
      const coin = coins[input.outpoint];
      if (!coin) continue;
      burned += BigInt(coin.atoms);
      delete coins[input.outpoint];
    }
    const vaultSpent = asset.status === "live" && inputs.some((input) => input.outpoint === asset.curve.vaultOutpoint);
    if (vaultSpent) broken = true;
    if (burned !== BigInt(asset.burnedAtoms ?? "0") || vaultSpent) {
      next.assets[assetId] = { ...asset, status: vaultSpent ? "broken" : asset.status,
        tokenUtxos: coins, burnedAtoms: burned.toString(), balances: derivedBalances(coins, asset.balances) };
    }
  }
  return outcome(next, broken ? "broken" : "invalid", reason);
}

function applyV2Operation(state: CoveLedgerState, observation: CoveObservation, txid: string,
  assetId: string, inputs: readonly VerifiedInput[], outputs: readonly TxOutput[]): CoveReplayResult {
  const asset = state.assets[assetId]!;
  const fail = (reason: string) => burnV2Inputs(state, observation, txid, inputs, reason);
  if (!validBalances(asset)) return fail("stored Cove token UTXOs are inconsistent");
  const formatted = validateCoveOperation(outputs, { txid: assetId.split(":")[1]!, ticker: asset.ticker }, 2);
  if (formatted.status !== "valid") return fail(formatted.reason);
  const otherAssets = spentV2Assets(state, inputs).filter((id) => id !== assetId);
  if (otherAssets.length) return fail("input contains another Cove token asset");
  if (Object.entries(state.assets).some(([id, other]) => id !== assetId && other.status === "live" &&
    inputs.some((input) => input.outpoint === other.curve.vaultOutpoint))) {
    return fail("input spends another Cove asset vault");
  }
  const amountAtoms = formatted.amountAtoms;
  const coins = { ...asset.tokenUtxos! };
  const recipientScript = outputs[1]!.scriptHex.toLowerCase();
  const vaultInput = inputs[0]?.outpoint === asset.curve.vaultOutpoint;
  const spentVault = inputs.some((input) => input.outpoint === asset.curve.vaultOutpoint);
  let curve = asset.curve;
  try {
    if (spentVault && !vaultInput) throw new Error("vault must be input zero");
    if (vaultInput) {
      if (asset.status !== "live") throw new Error("backing trading is unavailable");
      if (inputs[0]!.scriptHex.toLowerCase() !== asset.vaultScriptHex || BigInt(inputs[0]!.valueSats) !== curve.vaultSats) {
        throw new Error("vault prevout does not match current state");
      }
      if (!inputs[1]) throw new Error("missing buyer or seller input");
      if (formatted.kind === "mint" || recipientScript !== asset.vaultScriptHex) {
        if (formatted.changeVout !== undefined || inputs.slice(1).some((input) => !!coins[input.outpoint])) {
          throw new Error("buy funding contains tokens or token change");
        }
        const quote = quoteBuy(curve, amountAtoms / ATOMS_PER_TOKEN);
        if (formatted.kind !== quote.operation || outputs.length < 5 || outputs.length > 6 ||
          !exact(outputs[2], curve.vaultSats + quote.grossSats, asset.vaultScriptHex) ||
          !exact(outputs[3], quote.protocolFeeSats, asset.protocolScriptHex) ||
          !exact(outputs[4], quote.creatorFeeSats, asset.creatorScriptHex) ||
          !ordinaryChange(outputs, 5, [recipientScript, ...inputs.slice(1).map((input) => input.scriptHex)])) throw new Error("buy backing, fee, or recipient layout mismatch");
        const inventory = BigInt(coins[curve.vaultOutpoint]?.atoms ?? "0");
        if (quote.operation === "transfer" && inventory < amountAtoms) throw new Error("vault token inventory is insufficient");
        delete coins[curve.vaultOutpoint];
        curve = applyBuy(curve, { amountAtoms, previousVaultOutpoint: curve.vaultOutpoint,
          nextVaultOutpoint: `${txid}:2`, nextVaultSats: BigInt(outputs[2]!.valueSats),
          protocolFeeSats: BigInt(outputs[3]!.valueSats), creatorFeeSats: BigInt(outputs[4]!.valueSats) });
        coins[`${txid}:1`] = { scriptHex: recipientScript, atoms: amountAtoms.toString() };
        if (inventory > amountAtoms) coins[`${txid}:2`] = { scriptHex: asset.vaultScriptHex, atoms: (inventory - amountAtoms).toString() };
      } else {
        if (formatted.kind !== "transfer") throw new Error("sell requires transfer marker");
        const sellerCoin = coins[inputs[1]!.outpoint];
        if (!sellerCoin || sellerCoin.scriptHex !== inputs[1]!.scriptHex.toLowerCase()) throw new Error("seller token input is missing");
        const sellerScript = sellerCoin.scriptHex;
        let cursor = 1;
        let sellerAtoms = 0n;
        while (cursor < inputs.length && coins[inputs[cursor]!.outpoint]) {
          const input = inputs[cursor]!;
          const coin = coins[input.outpoint]!;
          if (coin.scriptHex !== sellerScript || input.scriptHex.toLowerCase() !== sellerScript) throw new Error("seller token inputs have different scripts");
          sellerAtoms += BigInt(coin.atoms);
          delete coins[input.outpoint];
          cursor++;
        }
        if (inputs.slice(cursor).some((input) => !!coins[input.outpoint]) || sellerAtoms < amountAtoms) {
          throw new Error("seller token inputs are incomplete");
        }
        const payoutScript = outputs[2]?.scriptHex.toLowerCase();
        if (!payoutScript || payoutScript !== sellerScript) throw new Error("seller payout recipient mismatch");
        const dust = dustThreshold(Buffer.from(payoutScript, "hex"));
        const quote = quoteSell(curve, amountAtoms / ATOMS_PER_TOKEN, dust);
        if (!exact(outputs[1], curve.vaultSats - quote.grossSats, asset.vaultScriptHex) ||
          !exact(outputs[2], quote.sellerPayoutSats, payoutScript) ||
          !exact(outputs[3], quote.protocolFeeSats, asset.protocolScriptHex)) throw new Error("sell backing, fee, or payout mismatch");
        const remainder = sellerAtoms - amountAtoms;
        if (remainder > 0n) {
          if (formatted.changeVout !== 4 || !outputs[4] || outputs[4].scriptHex.toLowerCase() !== sellerScript ||
            BigInt(outputs[4].valueSats) < dustThreshold(Buffer.from(sellerScript, "hex")) ||
            !ordinaryChange(outputs, 5, [sellerScript, ...inputs.slice(cursor).map((input) => input.scriptHex)])) {
            throw new Error("seller token change layout mismatch");
          }
          coins[`${txid}:4`] = { scriptHex: sellerScript, atoms: remainder.toString() };
        } else if (formatted.changeVout !== undefined || !ordinaryChange(outputs, 4, inputs.slice(1).map((input) => input.scriptHex))) {
          throw new Error("unexpected seller token change");
        }
        const inventory = BigInt(coins[curve.vaultOutpoint]?.atoms ?? "0");
        delete coins[curve.vaultOutpoint];
        curve = applySell(curve, { amountAtoms, previousVaultOutpoint: curve.vaultOutpoint,
          nextVaultOutpoint: `${txid}:1`, nextVaultSats: BigInt(outputs[1]!.valueSats),
          protocolFeeSats: BigInt(outputs[3]!.valueSats), sellerPayoutSats: BigInt(outputs[2]!.valueSats),
          walletTopUpSats: quote.walletTopUpSats, payoutDustSats: dust });
        coins[`${txid}:1`] = { scriptHex: asset.vaultScriptHex, atoms: (inventory + amountAtoms).toString() };
      }
    } else {
      if (formatted.kind !== "transfer" || !inputs[0]) throw new Error("peer transfer requires a token input zero");
      const first = coins[inputs[0].outpoint];
      if (!first || first.scriptHex !== inputs[0].scriptHex.toLowerCase() || first.scriptHex === asset.vaultScriptHex) {
        throw new Error("peer transfer input zero has no token allocation");
      }
      if (recipientScript === asset.vaultScriptHex) throw new Error("vault inventory requires a validated vault trade");
      const senderScript = first.scriptHex;
      let cursor = 0;
      let inputAtoms = 0n;
      while (cursor < inputs.length && coins[inputs[cursor]!.outpoint]) {
        const input = inputs[cursor]!;
        const coin = coins[input.outpoint]!;
        if (coin.scriptHex !== senderScript || input.scriptHex.toLowerCase() !== senderScript) throw new Error("peer token inputs have different scripts");
        inputAtoms += BigInt(coin.atoms);
        delete coins[input.outpoint];
        cursor++;
      }
      if (inputs.slice(cursor).some((input) => !!coins[input.outpoint]) || inputAtoms < amountAtoms) {
        throw new Error("peer token inputs are incomplete");
      }
      const remainder = inputAtoms - amountAtoms;
      if (remainder > 0n) {
        if (formatted.changeVout !== 2 || !outputs[2] || outputs[2].scriptHex.toLowerCase() !== senderScript ||
          BigInt(outputs[2].valueSats) < dustThreshold(Buffer.from(senderScript, "hex")) ||
          !ordinaryChange(outputs, 3, [senderScript, recipientScript, ...inputs.map((input) => input.scriptHex)])) throw new Error("peer token change layout mismatch");
        coins[`${txid}:2`] = { scriptHex: senderScript, atoms: remainder.toString() };
      } else if (formatted.changeVout !== undefined) {
        throw new Error("unexpected peer token change");
      } else if (outputs.length >= 4) {
        if (cursor !== 1 || !inputs[1] || !outputs[2] || !outputs[3] ||
          outputs[2].scriptHex.toLowerCase() !== senderScript ||
          BigInt(outputs[2].valueSats) < dustThreshold(Buffer.from(senderScript, "hex")) ||
          outputs[3].scriptHex.toLowerCase() !== asset.protocolScriptHex ||
          BigInt(outputs[3].valueSats) < dustThreshold(Buffer.from(asset.protocolScriptHex, "hex")) ||
          !ordinaryChange(outputs, 4, [recipientScript, ...inputs.slice(1).map((input) => input.scriptHex)])) {
          throw new Error("market payment or fee layout mismatch");
        }
      } else if (!ordinaryChange(outputs, 2, [recipientScript, ...inputs.map((input) => input.scriptHex)])) {
        throw new Error("unexpected peer output layout");
      }
      coins[`${txid}:1`] = { scriptHex: recipientScript, atoms: amountAtoms.toString() };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "invalid Cove v2 transaction");
  }
  const next = stamped(state, observation, txid);
  const nextAsset = { ...asset, curve, tokenUtxos: coins, balances: derivedBalances(coins, asset.balances) };
  if (!validBalances(nextAsset)) return fail("Cove token allocations do not conserve supply");
  next.assets[assetId] = nextAsset;
  return outcome(next, "applied", `${formatted.kind} indexed`);
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
  const spentV2 = spentV2Assets(state, inputs);
  const parsed = parseCrc20Transaction(outputs);
  if (parsed.status !== "valid") {
    if (spentV2.length || spentAssetIds.some((id) => state.assets[id]?.protocolVersion === 2)) {
      return burnV2Inputs(state, observation, txid, inputs, "confirmed spend without valid Cove v2 marker");
    }
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "confirmed invalid vault spend");
    return outcome(state, parsed.status === "none" ? "ignored" : "invalid", parsed.status === "none" ? "no CRC marker" : parsed.reason);
  }
  if (parsed.envelope.kind === "deploy") {
    if (spentV2.length) return burnV2Inputs(state, observation, txid, inputs, "token UTXO spent in deploy transaction");
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
      ...(parsed.envelope.payload.cv === "cove-curve-v2" ? {
        protocolVersion: 2 as const, tokenUtxos: {}, burnedAtoms: "0",
      } : {}),
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
    if (spentV2.length) return burnV2Inputs(state, observation, txid, inputs, "token UTXO spent with missing asset id");
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "vault spent with missing asset id");
    return outcome(state, "invalid", "missing Cove deployment id");
  }
  const assetId = crc20AssetId(observation.network, markerId);
  const asset = state.assets[assetId];
  if (!asset) {
    if (spentV2.length) return burnV2Inputs(state, observation, txid, inputs, "token UTXO spent for unknown asset id");
    if (spentAssetId) return breakVault(state, observation, txid, spentAssetIds, "vault spent for unknown asset id");
    return outcome(state, "ignored", "external deployment");
  }
  if (asset.protocolVersion === 2) return applyV2Operation(state, observation, txid, assetId, inputs, outputs);
  if (spentV2.length) return burnV2Inputs(state, observation, txid, inputs, "v1 operation spent v2 token UTXO");
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
