import { buildEscrowCancel } from "./escrow.js";
import { escrowCustody, validateEscrowConfig } from "./escrow-terms.js";
import { hash256, hex, utf8 } from "./bytes.js";
import type {
  Asset,
  Block,
  BlockUndo,
  ChainTransaction,
  Config,
  EscrowTerms,
  ConfirmedBlockOptions,
  ConfirmedEvent,
  Ledger,
  LedgerState,
  Offer,
  Plan,
  TransactionView,
} from "./types.js";
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
  curveBuyAmounts,
} from "./economics.js";
import {
  decodeTransaction,
  outpoint,
  parseRawTransaction,
  sats,
  verifySignatures,
  verifyInputSignature,
} from "./wire.js";
import { offerId, verifyOffer, prepareOfferRehydration } from "./offers.js";
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
export interface ValidatedTransition {
  ledger: Ledger;
  plan: Plan;
  kind: Exclude<ConfirmedEvent["kind"], "burn">;
  deployTxid: string;
  amountAtoms?: bigint;
  grossSats?: bigint;
  inventoryBuyAtoms?: bigint;
  newlyMintedAtoms?: bigint;
}
function applyTransaction(ledger: Ledger, transaction: ChainTransaction): Ledger {
  return transitionTransaction(ledger, transaction).ledger;
}
function transitionTransaction(
  ledger: Ledger,
  transaction: ChainTransaction,
  guardianUnsigned = false,
  allocationView = false,
): ValidatedTransition {
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
  if (guardianUnsigned) {
    if (transaction.prevouts.length !== tx.inputs.length) throw new Error("missing input prevouts");
    for (let index = 1; index < tx.inputs.length; index++)
      verifyInputSignature(tx, transaction.prevouts, index);
  } else {
    verifySignatures(
      tx,
      transaction.prevouts,
      authorized && !authorized.escrowTerms ? outpoint(authorized.listedInput) : undefined,
    );
  }
  const marker = decodeTransaction(
    tx.outputs.map((o, vout) => ({ vout, value_sats: o.sats, script_hex: o.scriptHex })),
  );
  if (marker.ticker !== ledger.config.ticker) throw new Error("unregistered ticker");
  const minerFeeSats =
    transaction.prevouts.reduce((sum, i) => sum + sats(i.sats), 0n) -
    tx.outputs.reduce((sum, o) => sum + o.sats, 0n);
  if (minerFeeSats < 1n || minerFeeSats > maxMinerFeeSats)
    throw new Error("miner fee outside policy");
  const inputs = transaction.prevouts.map((i, index) => ({
    ...i,
    sats: sats(i.sats),
    ...(/^a914[0-9a-f]{40}87$/.test(i.scriptHex)
      ? { redeemScriptHex: tx.inputs[index]!.scriptHex.slice(2) }
      : {}),
  }));
  const tokens = inputs
    .filter((i) => ledger.allocations[outpoint(i)])
    .map((i) => ({ ...i, ...ledger.allocations[outpoint(i)]! }));
  for (const offer of Object.values(ledger.offers)) {
    if (!offer.escrowTerms || !tokens.some((i) => outpoint(i) === outpoint(offer.listedInput)))
      continue;
    if (offer !== authorized || tokens.length !== 1)
      throw new Error("escrow requires sole token input at input zero");
    const registered = ledger.assets[offer.deployTxid];
    if (!registered) throw new Error("unregistered escrow asset");
    validateEscrowConfig(offer.escrowTerms, registered.config);
    verifyOffer(offer);
    if (!guardianUnsigned) {
      const witness = tx.inputs[0]!.witness,
        custody = escrowCustody(offer.escrowTerms);
      if (
        witness.length !== 4 ||
        witness[0]!.length !== 65 ||
        witness[0]![64] !== 1 ||
        hex(witness[1]!) !== custody.commitmentHex ||
        hex(witness[2]!) !== custody.executionScriptHex ||
        hex(witness[3]!) !== custody.controlBlockHex
      )
        throw new Error("escrow requires exact ALL execution witness");
    }
  }
  const vaultEntries = Object.values(ledger.assets).filter((a) =>
    inputs.some((i) => outpoint(i) === outpoint(a.vault)),
  );
  if (vaultEntries.length > 1) throw new Error("multiple vaults");
  let plan: Plan, asset: Asset, kind: ValidatedTransition["kind"];
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
        if (tokens.length || marker.markerVout !== 0) throw new Error("ambiguous issuance");
        const successor = tx.outputs[2];
        if (!successor) throw new Error("missing successor vault");
        const amount = deriveAmount(
          successor.sats - sats(asset.vault.sats),
          asset.issuedAtoms - asset.inventoryAtoms,
        );
        const amounts = curveBuyAmounts(asset, amount);
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
          issuedAtoms: asset.issuedAtoms + amounts.newlyMintedAtoms,
          inventoryAtoms: asset.inventoryAtoms - amounts.inventoryBuyAtoms,
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
        if (authorized?.escrowTerms) {
          plan = buildEscrowCancel({ offer: authorized, funding, changeScriptHex, minerFeeSats });
        } else
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
  const afterDeficit = total + asset.inventoryAtoms + asset.burnedAtoms - asset.issuedAtoms;
  if (allocationView) {
    const beforeAsset = ledger.assets[asset.deployTxid];
    const beforeTotal = Object.values(ledger.allocations)
      .filter((a) => a.deployTxid === asset.deployTxid)
      .reduce((sum, a) => sum + a.atoms, 0n);
    const beforeDeficit =
      beforeTotal +
      (beforeAsset?.inventoryAtoms ?? 0n) +
      (beforeAsset?.burnedAtoms ?? 0n) -
      (beforeAsset?.issuedAtoms ?? 0n);
    if (beforeDeficit > 0n || afterDeficit > 0n || beforeDeficit !== afterDeficit)
      throw new Error("transaction-view atom conservation failure");
  } else if (afterDeficit !== 0n) throw new Error("atom conservation failure");
  return {
    plan,
    kind,
    deployTxid: asset.deployTxid,
    amountAtoms:
      kind === "deploy"
        ? undefined
        : kind === "mint"
          ? plan.outputs[plan.recipientVout]!.atoms!
          : marker.amountAtoms!,
    ...(plan.inventoryBuyAtoms === undefined
      ? {}
      : {
          inventoryBuyAtoms: plan.inventoryBuyAtoms,
          newlyMintedAtoms: plan.newlyMintedAtoms,
        }),
    grossSats:
      kind === "mint" || kind === "inventoryBuy"
        ? sats(asset.vault.sats) - sats(ledger.assets[asset.deployTxid]!.vault.sats)
        : kind === "sell"
          ? sats(ledger.assets[asset.deployTxid]!.vault.sats) - sats(asset.vault.sats)
          : kind === "fill"
            ? usedOffer!.priceSats
            : undefined,
    ledger: {
      ...ledger,
      assets: { ...ledger.assets, [asset.deployTxid]: asset },
      allocations,
      spent,
      seen,
      offers,
    },
  };
}
/** Guardian preflight of the same transition; only the registered vault's own signature is absent.
 * The predicted ledger must not be persisted as a confirmed chain observation. */
function guardianTransaction(
  ledger: Ledger,
  transaction: ChainTransaction,
  allocationView = false,
): ValidatedTransition {
  const tx = parseRawTransaction(transaction.rawHex);
  const asset = Object.values(ledger.assets).find(
    (asset) => tx.inputs[0] && outpoint(asset.vault) === outpoint(tx.inputs[0]),
  );
  if (!asset?.config.guardianCustody) throw new Error("registered Guardian custody required");
  validateConfig(asset.config);
  if (asset.config.network !== ledger.config.network) throw new Error("Guardian network mismatch");
  if (asset.vaultAvailable === false || tx.inputs[0]!.witness.length || tx.inputs[0]!.scriptHex)
    throw new Error("Guardian input must be current and unsigned, not already finalized");
  if (
    tx.version !== 2 ||
    tx.locktime !== 0 ||
    tx.inputs.some((input) => input.sequence !== 0xfffffffe)
  )
    throw new Error("Guardian transaction header outside core plan");
  const claimed = transaction.prevouts[0];
  if (
    !claimed ||
    outpoint(claimed) !== outpoint(asset.vault) ||
    claimed.scriptHex !== asset.vault.scriptHex ||
    sats(claimed.sats) !== sats(asset.vault.sats)
  )
    throw new Error("Guardian vault prevout mismatch");
  const result = transitionTransaction(
    { ...ledger, config: asset.config },
    transaction,
    true,
    allocationView,
  );
  if (!["mint", "inventoryBuy", "sell"].includes(result.kind))
    throw new Error("Guardian operation requires vault transition");
  return { ...result, ledger: { ...result.ledger, config: ledger.config } };
}

/** Authenticate seller-signed listing bytes before admitting durable order metadata. */
export function validateEscrowListingTransaction(
  ledger: Ledger,
  terms: EscrowTerms,
  transaction: ChainTransaction,
): ValidatedTransition {
  const asset = ledger.assets[terms.deployTxid];
  if (!asset) throw new Error("unregistered escrow asset");
  validateEscrowConfig(terms, asset.config);
  const result = transitionTransaction({ ...ledger, config: asset.config }, transaction);
  const output = result.plan.outputs[1];
  if (
    result.kind !== "transfer" ||
    result.deployTxid !== terms.deployTxid ||
    result.amountAtoms !== terms.amountAtoms ||
    output?.scriptHex !== escrowCustody(terms).scriptHex ||
    output.sats !== carrierSats ||
    result.plan.inputs
      .filter((i) => ledger.allocations[outpoint(i)])
      .some((i) => i.scriptHex !== terms.sellerTokenScriptHex) ||
    result.plan.inputs
      .filter((i) => !ledger.allocations[outpoint(i)])
      .some((i) => i.scriptHex !== terms.sellerAuthorityScriptHex)
  )
    throw new Error("escrow signed seller listing mismatch");
  return result;
}

/** Only escrow input zero is unsigned; every buyer/seller funding signature is verified. */
function escrowGuardianTransaction(
  ledger: Ledger,
  transaction: ChainTransaction,
  allocationView = false,
): ValidatedTransition {
  const tx = parseRawTransaction(transaction.rawHex);
  const offer = Object.values(ledger.offers).find(
    (o) => o.escrowTerms && tx.inputs[0] && outpoint(o.listedInput) === outpoint(tx.inputs[0]),
  );
  if (!offer?.escrowTerms) throw new Error("registered escrow order required");
  const asset = ledger.assets[offer.deployTxid];
  if (!asset) throw new Error("unregistered escrow asset");
  verifyOffer(offer);
  validateEscrowConfig(offer.escrowTerms, asset.config);
  if (offer.status !== "open" && offer.status !== "cancelPending")
    throw new Error("escrow order unavailable");
  const input = transaction.prevouts[0];
  if (
    !input ||
    outpoint(input) !== outpoint(offer.listedInput) ||
    input.scriptHex !== offer.listedInput.scriptHex ||
    sats(input.sats) !== sats(offer.listedInput.sats)
  )
    throw new Error("escrow prevout mismatch");
  if (
    tx.version !== 2 ||
    tx.locktime !== 0 ||
    tx.inputs.some((i) => i.sequence !== 0xfffffffe) ||
    tx.inputs[0]!.witness.length ||
    tx.inputs[0]!.scriptHex
  )
    throw new Error("escrow input must be unsigned with canonical transaction header");
  const result = transitionTransaction(
    { ...ledger, config: asset.config },
    transaction,
    true,
    allocationView,
  );
  if (result.kind !== "fill" && result.kind !== "transfer")
    throw new Error("escrow operation requires fill or cancellation");
  if (
    result.kind === "fill" &&
    (offer.status !== "open" || !ledger.tip || ledger.tip.height >= offer.expiryHeight)
  )
    throw new Error("expired or unavailable escrow order");
  return { ...result, ledger: { ...result.ledger, config: ledger.config } };
}
export function validateEscrowGuardianTransaction(
  ledger: Ledger,
  transaction: ChainTransaction,
): ValidatedTransition {
  return escrowGuardianTransaction(ledger, transaction);
}
export function validateEscrowGuardianTransactionView(
  view: TransactionView,
  transaction: ChainTransaction,
): Omit<ValidatedTransition, "ledger"> {
  bindTransactionViewInputs(view, transaction.prevouts);
  const { ledger: _prediction, ...validated } = escrowGuardianTransaction(
    { ...view, history: {} },
    transaction,
    true,
  );
  return validated;
}

export function validateGuardianTransaction(
  ledger: Ledger,
  transaction: ChainTransaction,
): ValidatedTransition {
  return guardianTransaction(ledger, transaction);
}
/** Input-scoped wallet preview only; returns no ledger eligible for persistence. */
export function validateGuardianTransactionView(
  view: TransactionView,
  transaction: ChainTransaction,
): Omit<ValidatedTransition, "ledger"> {
  bindTransactionViewInputs(view, transaction.prevouts);
  const { ledger: _prediction, ...validated } = guardianTransaction(
    { ...view, history: {} },
    transaction,
    true,
  );
  return validated;
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
    history: retainedUndo(ledger, next, block.hash, 32),
  };
}
export function rollbackBlock(ledger: Ledger, hash: string): Ledger {
  if (ledger.tip?.hash !== hash || !ledger.history[hash])
    throw new Error("rollback requires current indexed tip");
  const undo = ledger.history[hash]!;
  const history = { ...ledger.history };
  delete history[hash];
  const restored: Ledger = {
    ...ledger,
    ...(undo.tip ? { tip: structuredClone(undo.tip) } : { tip: undefined }),
    assets: inverse(ledger.assets, undo.assets),
    allocations: inverse(ledger.allocations, undo.allocations),
    offers: inverse(ledger.offers, undo.offers),
    spent: inverse(ledger.spent, undo.spent),
    seen: inverse(ledger.seen, undo.seen),
    history,
  };
  for (const [id, offer] of Object.entries(restored.offers)) {
    if (offer.status !== "open" && offer.status !== "cancelPending") continue;
    const allocation = restored.allocations[outpoint(offer.listedInput)],
      asset = restored.assets[offer.deployTxid];
    if (
      !allocation ||
      !asset ||
      allocation.deployTxid !== offer.deployTxid ||
      allocation.atoms !== offer.listedInput.atoms ||
      allocation.sats !== sats(offer.listedInput.sats) ||
      allocation.scriptHex !== offer.listedInput.scriptHex ||
      asset.config.network !== offer.network ||
      asset.config.ticker !== offer.ticker
    )
      delete restored.offers[id];
  }
  return restored;
}

function diff<T>(before: Record<string, T>, after: Record<string, T>): Record<string, T | null> {
  const changes: Record<string, T | null> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (before[key] !== after[key])
      changes[key] = before[key] === undefined ? null : structuredClone(before[key]!);
  return changes;
}
function inverse<T>(
  current: Record<string, T>,
  changes: Record<string, T | null>,
): Record<string, T> {
  const result = { ...current };
  for (const [key, value] of Object.entries(changes))
    if (value === null) delete result[key];
    else result[key] = structuredClone(value);
  return result;
}
function retainedUndo(
  before: Ledger,
  after: Ledger,
  hash: string,
  limit: number,
): Record<string, BlockUndo> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("invalid undo retention limit");
  const undo: BlockUndo = {
    ...(before.tip ? { tip: structuredClone(before.tip) } : {}),
    assets: diff(before.assets, after.assets),
    allocations: diff(before.allocations, after.allocations),
    offers: diff(before.offers, after.offers),
    spent: diff(before.spent, after.spent),
    seen: diff(before.seen, after.seen),
  };
  return Object.fromEntries(
    [...Object.entries(before.history), [hash, undo] as const].slice(-limit),
  );
}
export function snapshotLedger(ledger: Ledger): LedgerState {
  const { history: _history, ...state } = ledger;
  return structuredClone(state);
}
export function restoreLedger(state: LedgerState, history: Record<string, BlockUndo> = {}): Ledger {
  validateConfig(state.config);
  for (const asset of Object.values(state.assets)) {
    validateConfig(asset.config);
    if (asset.config.network !== state.config.network)
      throw new Error("checkpoint network mismatch");
    const circulating = Object.values(state.allocations)
      .filter((a) => a.deployTxid === asset.deployTxid)
      .reduce((sum, a) => sum + a.atoms, 0n);
    if (circulating + asset.inventoryAtoms + asset.burnedAtoms !== asset.issuedAtoms)
      throw new Error("checkpoint atom conservation failure");
  }
  return { ...structuredClone(state), history: structuredClone(history) };
}
export class UnavailableParentError extends Error {
  constructor(message = "unavailable or inconsistent parent data") {
    super(message);
    this.name = "UnavailableParentError";
  }
}
function burnConfirmedInputs(ledger: Ledger, transaction: ChainTransaction): Ledger {
  const tx = parseRawTransaction(transaction.rawHex);
  const consumed = new Set(tx.inputs.map(outpoint));
  const allocations = { ...ledger.allocations },
    assets = { ...ledger.assets },
    offers = { ...ledger.offers },
    spent = { ...ledger.spent };
  for (const key of consumed) {
    const allocation = allocations[key];
    if (allocation) {
      const asset = assets[allocation.deployTxid]!;
      assets[allocation.deployTxid] = {
        ...asset,
        burnedAtoms: asset.burnedAtoms + allocation.atoms,
      };
      delete allocations[key];
      spent[key] = true;
    }
  }
  for (const [id, asset] of Object.entries(assets))
    if (consumed.has(outpoint(asset.vault))) {
      assets[id] = {
        ...asset,
        vaultAvailable: false,
        burnedAtoms: asset.burnedAtoms + asset.inventoryAtoms,
        inventoryAtoms: 0n,
      };
      spent[outpoint(asset.vault)] = true;
    }
  for (const [id, offer] of Object.entries(offers))
    if (consumed.has(outpoint(offer.listedInput))) offers[id] = { ...offer, status: "cancelled" };
  return {
    ...ledger,
    assets,
    allocations,
    offers,
    spent,
    seen: { ...ledger.seen, [tx.txid]: true },
  };
}
/** Chain observations only: Bitcoin consensus validity is established by the confirmed block.
 * Unsupported/non-protocol tracked spends destroy allocations; missing parent observations retry. */
export function applyConfirmedBlock(
  ledger: Ledger,
  block: Block,
  options: ConfirmedBlockOptions = {},
): Ledger {
  return applyConfirmedBlockDetailed(ledger, block, options).ledger;
}
/** Presentation facts come from the accepted core transition, never a second parser's decisions. */
export function applyConfirmedBlockDetailed(
  ledger: Ledger,
  block: Block,
  options: ConfirmedBlockOptions = {},
): { ledger: Ledger; events: ConfirmedEvent[] } {
  const events: ConfirmedEvent[] = [];
  if (
    block.timestamp !== undefined &&
    (!Number.isSafeInteger(block.timestamp) || block.timestamp < 1)
  )
    throw new Error("invalid confirmed timestamp");
  const fingerprint = hex(
    hash256(
      utf8(
        JSON.stringify(
          [
            block.parentHash,
            block.height,
            block.transactions,
            ...(block.timestamp === undefined ? [] : [block.timestamp]),
          ],
          (_, value) => (typeof value === "bigint" ? value.toString() : value),
        ),
      ),
    ),
  );
  if (ledger.tip?.hash === block.hash) {
    if (ledger.tip.fingerprint !== fingerprint) throw new Error("altered block contents");
    return { ledger, events };
  }
  if (ledger.history[block.hash]) throw new Error("block replay");
  if (
    ledger.tip &&
    (block.parentHash !== ledger.tip.hash || block.height !== ledger.tip.height + 1)
  )
    throw new Error("detached block or reorg requires rollback");
  const rehydrate = prepareOfferRehydration(ledger, options.authorizations ?? []);
  let next = rehydrate(ledger);
  for (const [txIndex, transaction] of block.transactions.entries()) {
    const tx = parseRawTransaction(transaction.rawHex);
    const consumed = new Set(tx.inputs.map(outpoint));
    const tracked = tx.inputs.some((i) => next.allocations[outpoint(i)]);
    const vaults = Object.values(next.assets).filter((a) => consumed.has(outpoint(a.vault)));
    const registration = options.registeredDeployments?.[tx.txid];
    if (!tracked && !vaults.length && !registration) continue;
    if (
      next.seen[tx.txid] ||
      tx.inputs.some((i) => next.spent[outpoint(i)]) ||
      consumed.size !== tx.inputs.length
    )
      throw new Error("replay or double spend");
    if (transaction.prevouts.length !== tx.inputs.length) throw new UnavailableParentError();
    transaction.prevouts.forEach((input, index) => {
      if (outpoint(input) !== outpoint(tx.inputs[index]!)) throw new UnavailableParentError();
      const allocation = next.allocations[outpoint(input)];
      const vault = vaults.find((a) => outpoint(a.vault) === outpoint(input))?.vault;
      const known = allocation ?? vault;
      if (known && (known.scriptHex !== input.scriptHex || sats(known.sats) !== sats(input.sats)))
        throw new UnavailableParentError();
    });
    const ordinaryParents = transaction.prevouts.filter(
      (input) =>
        !next.allocations[outpoint(input)] &&
        !vaults.some((a) => outpoint(a.vault) === outpoint(input)),
    );
    for (const input of ordinaryParents) {
      const parentHex = transaction.parentRawTransactions?.[input.txid];
      if (parentHex === undefined) continue;
      try {
        const parent = parseRawTransaction(parentHex),
          output = parent.outputs[input.vout];
        if (
          parent.txid !== input.txid ||
          !output ||
          output.sats !== sats(input.sats) ||
          output.scriptHex !== input.scriptHex
        )
          throw new Error("parent mismatch");
      } catch {
        throw new UnavailableParentError();
      }
    }
    const token = tx.inputs.map((i) => next.allocations[outpoint(i)]).find(Boolean);
    const selected =
      registration ?? (token ? next.assets[token.deployTxid]!.config : vaults[0]!.config);
    validateConfig(selected);
    if (selected.network !== ledger.config.network)
      throw new Error("registered deployment network mismatch");
    try {
      const transition = transitionTransaction({ ...next, config: selected }, transaction);
      next = {
        ...transition.ledger,
        config: ledger.config,
      };
      events.push({
        txid: tx.txid,
        txIndex,
        deployTxid: transition.deployTxid,
        kind: transition.kind,
        valid: true,
        amountAtoms: transition.amountAtoms,
        grossSats: transition.grossSats,
        ...(transition.inventoryBuyAtoms === undefined
          ? {}
          : {
              inventoryBuyAtoms: transition.inventoryBuyAtoms,
              newlyMintedAtoms: transition.newlyMintedAtoms,
            }),
      });
    } catch {
      // Full parent bytes are needed before burning for unsupported funded spends.
      // A failed signature can reflect corrupt ordinary observations, not CRC invalidity.
      if (
        ordinaryParents.some(
          (input) => transaction.parentRawTransactions?.[input.txid] === undefined,
        )
      )
        throw new UnavailableParentError(
          "parent authentication required for invalid confirmed spend",
        );
      const burned = burnConfirmedInputs(next, transaction);
      for (const [id, asset] of Object.entries(burned.assets)) {
        const previous = next.assets[id]!;
        if (asset !== previous)
          events.push({
            txid: tx.txid,
            txIndex,
            deployTxid: id,
            kind: "burn",
            valid: false,
            amountAtoms: asset.burnedAtoms - previous.burnedAtoms,
            grossSats: undefined,
          });
      }
      next = burned;
    }
    next = rehydrate(
      next,
      tx.outputs.map((_, vout) => `${tx.txid}:${vout}`),
    );
  }
  return {
    events,
    ledger: {
      ...next,
      tip: { hash: block.hash, height: block.height, fingerprint },
      history: retainedUndo(ledger, next, block.hash, options.undoLimit ?? 32),
    },
  };
}

/** Verify build intent; supply the current ledger to also preflight protocol allocation rules. */
function finalTransaction(
  plan: Plan,
  transaction: ChainTransaction,
  ledger?: Ledger,
  allocationView = false,
): string {
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
  if (ledger) {
    const transition = transitionTransaction(ledger, transaction, false, allocationView);
    if (transition.kind === "mint" || transition.kind === "inventoryBuy") {
      if (
        plan.outputs[plan.recipientVout]!.atoms !== transition.amountAtoms ||
        plan.inventoryBuyAtoms !== transition.inventoryBuyAtoms ||
        plan.newlyMintedAtoms !== transition.newlyMintedAtoms
      )
        throw new Error("quoted buy amount or inventory breakdown differs from transition");
    }
  }
  return tx.txid;
}

export function validateFinalTransaction(
  plan: Plan,
  transaction: ChainTransaction,
  ledger?: Ledger,
): string {
  return finalTransaction(plan, transaction, ledger);
}
/** Preview the same transition against observed inputs; full confirmed totals remain a server/indexer gate. */
export function validateFinalTransactionView(
  plan: Plan,
  transaction: ChainTransaction,
  view: TransactionView,
): string {
  bindTransactionViewInputs(view, plan.inputs, true);
  return finalTransaction(plan, transaction, { ...view, history: {} }, true);
}

function bindTransactionViewInputs(
  view: TransactionView,
  inputs: Plan["inputs"],
  reviewed = false,
): void {
  for (const input of inputs) {
    const allocation = view.allocations[outpoint(input)];
    if (
      allocation &&
      (allocation.scriptHex !== input.scriptHex ||
        allocation.sats !== sats(input.sats) ||
        ((reviewed || input.atoms !== undefined) && input.atoms !== allocation.atoms) ||
        (input.deployTxid !== undefined && input.deployTxid !== allocation.deployTxid))
    )
      throw new Error("input allocation differs from transaction view");
  }
}
