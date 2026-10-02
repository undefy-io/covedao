import { hash256, hex, utf8 } from "./bytes.js";
import type { Asset, Block, ChainTransaction, Config, Ledger, Offer, Plan } from "./types.js";
import {
  buildDeploy,
  buildInventoryBuy,
  buildMint,
  buildPurchase,
  buildSell,
  buildTransfer,
  deployMarker,
  validateConfig,
} from "./builders.js";
import {
  backingSats,
  capAtoms,
  carrierSats,
  curveStepAtoms,
  maxMinerFeeSats,
} from "./economics.js";
import {
  decodeTransaction,
  outpoint,
  parseRawTransaction,
  sats,
  verifySignatures,
} from "./wire.js";
import { offerId, verifyOffer } from "./offers.js";
export function emptyLedger(config: Config): Ledger {
  validateConfig(config);
  return {
    config: structuredClone(config),
    assets: {},
    allocations: {},
    offers: {},
    spent: {},
    seen: {},
    history: {},
  };
}
function deriveAmount(gross: bigint, before: bigint): bigint {
  if (gross <= 0n) throw new Error("invalid mint payment");
  const target = backingSats(before) + gross;
  let low = before / curveStepAtoms + 1n,
    high = capAtoms / curveStepAtoms;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (backingSats(middle * curveStepAtoms) < target) low = middle + 1n;
    else high = middle;
  }
  if (backingSats(low * curveStepAtoms) !== target)
    throw new Error("ambiguous or wrong mint payment");
  return low * curveStepAtoms - before;
}
function compare(plan: Plan, outputs: { sats: bigint; scriptHex: string }[]): void {
  if (
    plan.outputs.length !== outputs.length ||
    plan.outputs.some(
      (o, i) => o.sats !== outputs[i]!.sats || o.scriptHex !== outputs[i]!.scriptHex,
    )
  )
    throw new Error("transaction outputs violate registered transition, fees or token change");
}
function applyTransaction(ledger: Ledger, transaction: ChainTransaction): Ledger {
  const tx = parseRawTransaction(transaction.rawHex);
  if (
    ledger.seen[tx.txid] ||
    tx.inputs.some((i) => ledger.spent[outpoint(i)]) ||
    new Set(tx.inputs.map(outpoint)).size !== tx.inputs.length
  )
    throw new Error("replay or double spend");
  const authorized = Object.values(ledger.offers).find(
    (o) => outpoint(o.listedInput) === outpoint(tx.inputs[0]!),
  );
  verifySignatures(
    tx,
    transaction.prevouts,
    authorized ? outpoint(authorized.listedInput) : undefined,
  );
  const marker = decodeTransaction(
    tx.outputs.map((o, vout) => ({ vout, value_sats: o.sats, script_hex: o.scriptHex })),
  );
  if (marker.ticker !== ledger.config.ticker) throw new Error("unregistered ticker");
  const minerFeeSats =
    transaction.prevouts.reduce((sum, i) => sum + sats(i.sats), 0n) -
    tx.outputs.reduce((sum, o) => sum + o.sats, 0n);
  if (minerFeeSats < 1n || minerFeeSats > maxMinerFeeSats)
    throw new Error("miner fee outside policy");
  const inputs = transaction.prevouts.map((i) => ({ ...i, sats: sats(i.sats) }));
  const tokens = inputs
    .filter((i) => ledger.allocations[outpoint(i)])
    .map((i) => ({ ...i, ...ledger.allocations[outpoint(i)]! }));
  const vaultEntries = Object.values(ledger.assets).filter((a) =>
    inputs.some((i) => outpoint(i) === outpoint(a.vault)),
  );
  if (vaultEntries.length > 1) throw new Error("multiple vaults");
  let plan: Plan, asset: Asset, kind: string;
  let usedOffer: Offer | undefined;
  if (marker.operation === "deploy") {
    if (
      tokens.length ||
      vaultEntries.length ||
      marker.markerJson !== deployMarker(ledger.config.ticker)
    )
      throw new Error("invalid deployment");
    plan = buildDeploy({
      config: ledger.config,
      funding: inputs,
      changeScriptHex: tx.outputs.at(-1)!.scriptHex,
      minerFeeSats,
    });
    asset = {
      config: ledger.config,
      deployTxid: tx.txid,
      issuedAtoms: 0n,
      inventoryAtoms: 0n,
      burnedAtoms: 0n,
      vault: { txid: tx.txid, vout: 1, sats: carrierSats, scriptHex: ledger.config.vaultScriptHex },
    };
    kind = "deploy";
  } else {
    const ids = new Set(tokens.map((t) => t.deployTxid));
    if (vaultEntries[0]) ids.add(vaultEntries[0].deployTxid);
    if (ids.size !== 1) throw new Error("missing token input or wrong asset");
    const id = Array.from(ids)[0]!;
    asset = ledger.assets[id]!;
    if (!asset) throw new Error("unregistered asset");
    const vault = vaultEntries[0];
    const tokenOutpoints = new Set(tokens.map(outpoint));
    const funding = inputs.filter(
      (i) => !tokenOutpoints.has(outpoint(i)) && (!vault || outpoint(i) !== outpoint(vault.vault)),
    );
    const changeScriptHex = tx.outputs.at(-1)!.scriptHex;
    const recipientScriptHex = tx.outputs[marker.recipientVout]!.scriptHex;
    if (vault) {
      if (inputs[0] && outpoint(inputs[0]) !== outpoint(asset.vault))
        throw new Error("vault must be input zero");
      if (marker.operation === "mint") {
        if (tokens.length || marker.markerVout !== 0 || asset.inventoryAtoms)
          throw new Error("ambiguous issuance");
        const successor = tx.outputs[2];
        if (!successor) throw new Error("missing successor vault");
        const amount = deriveAmount(successor.sats - sats(asset.vault.sats), asset.issuedAtoms);
        plan = buildMint({
          state: asset,
          funding,
          recipientScriptHex,
          changeScriptHex,
          amountAtoms: amount,
          minerFeeSats,
        });
        asset = {
          ...asset,
          issuedAtoms: asset.issuedAtoms + amount,
          vault: {
            txid: tx.txid,
            vout: 2,
            sats: plan.outputs[2]!.sats,
            scriptHex: asset.config.vaultScriptHex,
          },
        };
        kind = "mint";
      } else if (tokens.length) {
        if (marker.markerVout !== 0) throw new Error("invalid sell output position");
        plan = buildSell({
          state: asset,
          inputs: tokens,
          funding,
          recipientScriptHex: tx.outputs[2]!.scriptHex,
          changeScriptHex,
          amountAtoms: marker.amountAtoms!,
          minerFeeSats,
        });
        asset = {
          ...asset,
          inventoryAtoms: asset.inventoryAtoms + marker.amountAtoms!,
          vault: {
            txid: tx.txid,
            vout: 1,
            sats: plan.outputs[1]!.sats,
            scriptHex: asset.config.vaultScriptHex,
          },
        };
        kind = "sell";
      } else {
        if (marker.markerVout !== 0) throw new Error("invalid inventory output position");
        plan = buildInventoryBuy({
          state: asset,
          funding,
          recipientScriptHex,
          changeScriptHex,
          amountAtoms: marker.amountAtoms!,
          minerFeeSats,
        });
        asset = {
          ...asset,
          inventoryAtoms: asset.inventoryAtoms - marker.amountAtoms!,
          vault: {
            txid: tx.txid,
            vout: 2,
            sats: plan.outputs[2]!.sats,
            scriptHex: asset.config.vaultScriptHex,
          },
        };
        kind = "inventoryBuy";
      }
    } else {
      if (marker.operation !== "transfer") throw new Error("mint requires current vault");
      if (marker.markerVout === 1) {
        usedOffer = authorized;
        if (!usedOffer) throw new Error("unregistered market offer");
        verifyOffer(usedOffer);
        if (
          tokens.length !== 1 ||
          tokens[0]!.atoms !== usedOffer.listedInput.atoms ||
          marker.amountAtoms !== usedOffer.listedInput.atoms ||
          usedOffer.deployTxid !== id
        )
          throw new Error("wrong listed token outpoint or amount");
        // Confirmed settlement is governed by the actual outpoint spend, not an
        // off-chain expiry/status. Rebuild the terms without constructing a new offer purchase.
        plan = buildPurchase({
          listedInput: usedOffer.listedInput,
          priceSats: usedOffer.priceSats,
          sellerScriptHex: usedOffer.sellerScriptHex,
          ticker: usedOffer.ticker,
          buyerFunding: funding,
          buyerScriptHex: recipientScriptHex,
          protocolScriptHex: asset.config.protocolScriptHex,
          changeScriptHex,
          minerFeeSats,
        });
        kind = "fill";
      } else {
        if (marker.markerVout !== 0)
          throw new Error("unregistered market offer or invalid transfer position");
        plan = buildTransfer({
          network: asset.config.network,
          deployTxid: id,
          ticker: asset.config.ticker,
          inputs: tokens,
          funding,
          amountAtoms: marker.amountAtoms!,
          recipientScriptHex,
          changeScriptHex,
          minerFeeSats,
        });
        kind = "transfer";
      }
    }
  }
  compare(plan, tx.outputs);
  const allocations = { ...ledger.allocations },
    spent = { ...ledger.spent },
    seen = { ...ledger.seen, [tx.txid]: true as const },
    offers = { ...ledger.offers };
  for (const input of inputs) {
    delete allocations[outpoint(input)];
    spent[outpoint(input)] = true;
  }
  for (const [vout, output] of plan.outputs.entries())
    if (output.atoms !== undefined && output.role !== "vault")
      allocations[`${tx.txid}:${vout}`] = {
        atoms: output.atoms,
        sats: output.sats,
        scriptHex: output.scriptHex,
        deployTxid: asset.deployTxid,
      };
  // Every accepted spend retires all authorizations attached to consumed outputs,
  // including owner transfers, curve sales and spends of multiple listed carriers.
  const consumed = new Set(inputs.map(outpoint));
  for (const [id, offer] of Object.entries(offers))
    if (consumed.has(outpoint(offer.listedInput)))
      offers[id] = {
        ...offer,
        status: usedOffer && id === offerId(usedOffer) && kind === "fill" ? "filled" : "cancelled",
      };
  const total = Object.values(allocations)
    .filter((a) => a.deployTxid === asset.deployTxid)
    .reduce((sum, a) => sum + a.atoms, 0n);
  if (total + asset.inventoryAtoms + asset.burnedAtoms !== asset.issuedAtoms)
    throw new Error("atom conservation failure");
  return {
    ...ledger,
    assets: { ...ledger.assets, [asset.deployTxid]: asset },
    allocations,
    spent,
    seen,
    offers,
  };
}
export function applyBlock(ledger: Ledger, block: Block): Ledger {
  const fingerprint = hex(
    hash256(
      utf8(
        JSON.stringify([block.parentHash, block.height, block.transactions], (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ),
    ),
  );
  if (ledger.tip?.hash === block.hash) {
    if (ledger.tip.fingerprint !== fingerprint) throw new Error("altered block contents");
    return ledger;
  }
  if (ledger.history[block.hash]) throw new Error("block replay");
  if (
    ledger.tip &&
    (block.parentHash !== ledger.tip.hash || block.height !== ledger.tip.height + 1)
  )
    throw new Error("detached block or reorg requires rollback");
  let next = ledger;
  for (const tx of block.transactions) next = applyTransaction(next, tx);
  return {
    ...next,
    tip: { hash: block.hash, height: block.height, fingerprint },
    history: { ...ledger.history, [block.hash]: ledger },
  };
}
export function rollbackBlock(ledger: Ledger, hash: string): Ledger {
  if (ledger.tip?.hash !== hash || !ledger.history[hash])
    throw new Error("rollback requires current indexed tip");
  return ledger.history[hash]!;
}

/** Verify the finalized spend against the user's quote/build intent before broadcasting. */
export function validateFinalTransaction(plan: Plan, transaction: ChainTransaction): string {
  const tx = parseRawTransaction(transaction.rawHex);
  if (
    tx.version !== 2 ||
    tx.locktime !== 0 ||
    tx.inputs.length !== plan.inputs.length ||
    tx.inputs.some((i, n) => outpoint(i) !== outpoint(plan.inputs[n]!) || i.sequence !== 0xfffffffe)
  )
    throw new Error("final inputs differ from quoted plan");
  if (
    transaction.prevouts.some(
      (i, n) =>
        sats(i.sats) !== sats(plan.inputs[n]!.sats) || i.scriptHex !== plan.inputs[n]!.scriptHex,
    )
  )
    throw new Error("final prevouts differ from quoted plan");
  verifySignatures(
    tx,
    transaction.prevouts,
    plan.inputWitnesses?.[0] ? outpoint(plan.inputs[0]!) : undefined,
  );
  compare(plan, tx.outputs);
  const marker = decodeTransaction(
    tx.outputs.map((o, vout) => ({ vout, value_sats: o.sats, script_hex: o.scriptHex })),
  );
  if (
    marker.markerJson !== plan.markerJson ||
    marker.markerVout !== plan.markerVout ||
    marker.recipientVout !== plan.recipientVout
  )
    throw new Error("final marker differs from quoted plan");
  const minerFee =
    transaction.prevouts.reduce((sum, i) => sum + sats(i.sats), 0n) -
    tx.outputs.reduce((sum, o) => sum + o.sats, 0n);
  if (minerFee !== plan.minerFeeSats || minerFee < 1n || minerFee > maxMinerFeeSats)
    throw new Error("final miner fee differs from quote");
  return tx.txid;
}
