import { requireSupportedInputScript, requireSupportedOutputScript } from "./target.js";
import { validateGuardianCustody } from "./taproot.js";
import type { Asset, Config, GuardianCustody, Input, Offer, Output, Plan } from "./types.js";
import {
  capAtoms,
  carrierSats,
  launchFeeSats,
  marketFee,
  maxMinerFeeSats,
  quoteBuy,
  quoteSell,
  backingSats,
  curveBuyAmounts,
} from "./economics.js";
import { markerScript, outpoint, sats, spendable } from "./wire.js";
import { verifyOffer } from "./offers.js";
export const transferMarker = (ticker: string, atoms: bigint): string =>
  JSON.stringify({ p: "crc-20", op: "transfer", tick: ticker, amt: atoms.toString() });
export const mintMarker = (ticker: string): string =>
  JSON.stringify({ p: "crc-20", op: "mint", tick: ticker });
export const deployMarker = (ticker: string): string =>
  JSON.stringify({
    p: "crc-20",
    op: "deploy",
    tick: ticker,
    type: "bonding",
    max: "21000000",
    lim: "21000000",
    leaf: "0",
    ordi: "0",
    btc: "1",
  });
export function validateConfig(config: Config): void {
  if (
    !["regtest", "signet", "testnet", "bitcoin"].includes(config.network) ||
    !/^[A-Za-z0-9]{1,16}$/.test(config.ticker)
  )
    throw new Error("invalid deployment identity");
  if (config.vaultScriptHex.startsWith("5120")) {
    if (!config.guardianCustody)
      throw new Error("Taproot vault requires registered Guardian custody");
    validateGuardianCustody(config.vaultScriptHex, config.guardianCustody);
  } else if (config.guardianCustody || !/^0014[0-9a-f]{40}$/.test(config.vaultScriptHex)) {
    throw new Error("unsupported or downgraded vault custody");
  }
  for (const script of [config.vaultScriptHex, config.creatorScriptHex, config.protocolScriptHex])
    requireSupportedOutputScript(script);
}
/** Production adapters select this contract, including independently trusted recovery metadata. */
export function guardianConfig(config: Config, custody: GuardianCustody): Config {
  const selected = { ...structuredClone(config), guardianCustody: structuredClone(custody) };
  validateConfig(selected);
  return selected;
}
const output = (role: string, scriptHex: string, value: bigint, atoms?: bigint): Output => {
  if (role !== "marker") {
    requireSupportedOutputScript(scriptHex);
    if (value < carrierSats && role !== "creatorFee") throw new Error("unspendable/dust output");
  }
  return { role, scriptHex, sats: value, ...(atoms === undefined ? {} : { atoms }) };
};
function ordinaryFunding(inputs: Input[]): Input[] {
  if (inputs.some((input) => input.atoms !== undefined || input.deployTxid !== undefined))
    throw new Error("token carriers cannot be used as ordinary BTC funding");
  return inputs;
}
function finish(
  inputs: Input[],
  outputs: Output[],
  markerJson: string,
  changeScriptHex: string,
  minerFeeSats = 1000n,
  extras: Partial<Plan> = {},
): Plan {
  if (minerFeeSats < 1n || minerFeeSats > maxMinerFeeSats)
    throw new Error("miner fee outside policy");
  if (!inputs.length || new Set(inputs.map(outpoint)).size !== inputs.length)
    throw new Error("missing or duplicate input");
  for (const input of inputs) {
    requireSupportedInputScript(input.scriptHex, input.redeemScriptHex);
    if (
      !/^[0-9a-f]{64}$/.test(input.txid) ||
      !Number.isInteger(input.vout) ||
      input.vout < 0 ||
      !spendable(input.scriptHex)
    )
      throw new Error("invalid input");
    sats(input.sats);
  }
  const change =
    inputs.reduce((sum, i) => sum + sats(i.sats), 0n) -
    outputs.reduce((sum, o) => sum + o.sats, 0n) -
    minerFeeSats;
  if (change < 0n) throw new Error("insufficient BTC funding");
  if (change > 0n) outputs.push(output("btcChange", changeScriptHex, change));
  const markerVout = outputs.findIndex((o) => o.role === "marker");
  return {
    inputs,
    outputs,
    transactions: [{ inputs, outputs }],
    markerJson,
    markerVout,
    recipientVout: markerVout + 1,
    changeAtoms: 0n,
    protocolFeeSats: 0n,
    creatorFeeSats: 0n,
    minerFeeSats,
    ...extras,
  };
}
export interface TransferArgs {
  network: string;
  deployTxid: string;
  ticker: string;
  input?: Input;
  inputs?: Input[];
  funding?: Input[];
  amountAtoms: bigint;
  recipientScriptHex?: string;
  sellerScriptHex?: string;
  changeScriptHex?: string;
  minerFeeSats?: bigint;
  priceSats?: bigint;
}
function tokenInputs(args: Pick<TransferArgs, "input" | "inputs" | "amountAtoms" | "deployTxid">) {
  const inputs = args.inputs ?? (args.input ? [args.input] : []);
  if (
    !inputs.length ||
    inputs.some(
      (i) =>
        typeof i.atoms !== "bigint" ||
        i.atoms <= 0n ||
        (i.deployTxid !== undefined && i.deployTxid !== args.deployTxid),
    )
  )
    throw new Error("missing or wrong-asset token inputs");
  const owner = inputs[0]!.scriptHex;
  if (inputs.some((i) => i.scriptHex !== owner))
    throw new Error("token inputs must have one change owner");
  const total = inputs.reduce((sum, i) => sum + i.atoms!, 0n);
  if (typeof args.amountAtoms !== "bigint" || args.amountAtoms <= 0n || args.amountAtoms > total)
    throw new Error("invalid amount or insufficient balance");
  return { inputs, owner, changeAtoms: total - args.amountAtoms };
}
export function buildTransfer(args: TransferArgs): Plan {
  if (
    !["regtest", "signet", "testnet", "bitcoin"].includes(args.network) ||
    !/^[0-9a-f]{64}$/.test(args.deployTxid) ||
    !/^[A-Za-z0-9]{1,16}$/.test(args.ticker)
  )
    throw new Error("invalid transfer identity");
  const tokens = tokenInputs(args);
  const recipient = args.recipientScriptHex ?? args.sellerScriptHex ?? "";
  const markerJson = transferMarker(args.ticker, args.amountAtoms);
  const outputs = [
    output("marker", markerScript(markerJson), 0n),
    output("recipient", recipient, carrierSats, args.amountAtoms),
  ];
  if (tokens.changeAtoms)
    outputs.push(output("tokenChange", tokens.owner, carrierSats, tokens.changeAtoms));
  return finish(
    [...tokens.inputs, ...ordinaryFunding(args.funding ?? [])],
    outputs,
    markerJson,
    args.changeScriptHex ?? tokens.owner,
    args.minerFeeSats,
    { changeAtoms: tokens.changeAtoms },
  );
}
export function buildListing(args: TransferArgs): Plan {
  if (!/^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(args.sellerScriptHex ?? ""))
    throw new Error("unsupported seller signing script for reusable offers");
  if (tokenInputs(args).owner !== args.sellerScriptHex)
    throw new Error("listing seller must own the token inputs");
  if (!args.priceSats || args.priceSats <= 0n)
    throw new Error("positive integer-sat listing price required");
  const plan = buildTransfer({ ...args, recipientScriptHex: args.sellerScriptHex });
  return { ...plan, listedAtoms: args.amountAtoms };
}
export function buildDeploy(args: {
  config: Config;
  funding: Input[];
  changeScriptHex: string;
  minerFeeSats?: bigint;
}): Plan {
  validateConfig(args.config);
  const c = args.config,
    markerJson = deployMarker(c.ticker);
  return finish(
    ordinaryFunding(args.funding),
    [
      output("marker", markerScript(markerJson), 0n),
      output("vault", c.vaultScriptHex, carrierSats),
      output("creatorRecord", c.creatorScriptHex, carrierSats),
      output("protocolFee", c.protocolScriptHex, launchFeeSats),
    ],
    markerJson,
    args.changeScriptHex,
    args.minerFeeSats,
    { protocolFeeSats: launchFeeSats },
  );
}
export interface TradeArgs {
  state: Asset;
  funding: Input[];
  recipientScriptHex: string;
  changeScriptHex?: string;
  amountAtoms: bigint;
  minerFeeSats?: bigint;
  inputs?: Input[];
}
export function validateAssetVault(state: Asset): void {
  if (state.vaultAvailable === false) throw new Error("vault unavailable");
  validateConfig(state.config);
  if (
    sats(state.vault.sats) !==
      carrierSats + backingSats(state.issuedAtoms - state.inventoryAtoms) ||
    state.vault.scriptHex !== state.config.vaultScriptHex ||
    state.issuedAtoms > capAtoms ||
    state.inventoryAtoms < 0n
  )
    throw new Error("invalid vault state or insufficient backing");
}
function buy(args: TradeArgs, inventory: boolean): Plan {
  validateAssetVault(args.state);
  const state = args.state,
    c = state.config;
  const amounts = curveBuyAmounts(state, args.amountAtoms);
  if (inventory ? amounts.newlyMintedAtoms > 0n : amounts.newlyMintedAtoms === 0n)
    throw new Error("buy builder does not match inventory/issuance transition");
  const quote = quoteBuy(state, args.amountAtoms);
  const markerJson = inventory ? transferMarker(c.ticker, args.amountAtoms) : mintMarker(c.ticker);
  return finish(
    [state.vault, ...ordinaryFunding(args.funding)],
    [
      output("marker", markerScript(markerJson), 0n),
      output("recipient", args.recipientScriptHex, carrierSats, args.amountAtoms),
      output("vault", c.vaultScriptHex, sats(state.vault.sats) + quote.grossSats),
      output("protocolFee", c.protocolScriptHex, quote.protocolFeeSats),
      output("creatorFee", c.creatorScriptHex, quote.creatorFeeSats),
    ],
    markerJson,
    args.changeScriptHex ?? args.recipientScriptHex,
    args.minerFeeSats,
    { ...quote, ...(amounts.inventoryBuyAtoms && amounts.newlyMintedAtoms ? amounts : {}) },
  );
}
export const buildMint = (args: TradeArgs): Plan => buy(args, false);
export const buildInventoryBuy = (args: TradeArgs): Plan => buy(args, true);
/** A single purchase consumes inventory first and issues only the remainder. */
export const buildBuy = (args: TradeArgs): Plan =>
  buy(args, curveBuyAmounts(args.state, args.amountAtoms).newlyMintedAtoms === 0n);
export function buildSell(args: TradeArgs): Plan {
  validateAssetVault(args.state);
  const state = args.state,
    c = state.config,
    tokens = tokenInputs({
      inputs: args.inputs,
      amountAtoms: args.amountAtoms,
      deployTxid: state.deployTxid,
    });
  const quote = quoteSell(state, args.amountAtoms),
    markerJson = transferMarker(c.ticker, args.amountAtoms);
  const payout = quote.sellerPayoutSats;
  const outputs = [
    output("marker", markerScript(markerJson), 0n),
    output("vault", c.vaultScriptHex, sats(state.vault.sats) - quote.grossSats, args.amountAtoms),
    output("payout", args.recipientScriptHex, payout),
  ];
  if (tokens.changeAtoms)
    outputs.push(output("tokenChange", tokens.owner, carrierSats, tokens.changeAtoms));
  outputs.push(output("protocolFee", c.protocolScriptHex, quote.protocolFeeSats));
  const recovered = tokens.inputs.reduce((sum, i) => sum + sats(i.sats), 0n);
  const walletTopUpSats =
    payout +
    quote.protocolFeeSats +
    (tokens.changeAtoms ? carrierSats : 0n) +
    (args.minerFeeSats ?? 1000n) -
    quote.grossSats -
    recovered;
  return finish(
    [state.vault, ...tokens.inputs, ...ordinaryFunding(args.funding)],
    outputs,
    markerJson,
    args.changeScriptHex ?? tokens.owner,
    args.minerFeeSats,
    {
      ...quote,
      changeAtoms: tokens.changeAtoms,
      walletTopUpSats: walletTopUpSats > 0n ? walletTopUpSats : 0n,
    },
  );
}
export interface PurchaseArgs {
  offer?: Offer;
  /** Required for new presigned purchases; expiry is advisory, not a Bitcoin timelock. */
  currentHeight?: number;
  network?: string;
  deployTxid?: string;
  ticker?: string;
  listedInput?: Input & { atoms: bigint };
  buyerFunding: Input[];
  buyerScriptHex: string;
  sellerScriptHex?: string;
  priceSats?: bigint;
  protocolScriptHex: string;
  changeScriptHex?: string;
  minerFeeSats?: bigint;
}
export function buildPurchase(args: PurchaseArgs): Plan {
  if (args.offer) {
    verifyOffer(args.offer);
    if (
      !Number.isSafeInteger(args.currentHeight) ||
      args.currentHeight! < 0 ||
      args.currentHeight! >= args.offer.expiryHeight ||
      (args.offer.status !== undefined && args.offer.status !== "open")
    )
      throw new Error("expired or unavailable offer, or missing current height");
  }
  const input = args.offer?.listedInput ?? args.listedInput;
  const price = args.offer?.priceSats ?? args.priceSats;
  const seller = args.offer?.sellerScriptHex ?? args.sellerScriptHex;
  const ticker = args.offer?.ticker ?? args.ticker;
  if (!input || !price || !seller || !ticker) throw new Error("missing listing terms");
  if (input.atoms <= 0n) throw new Error("invalid listing amount");
  const protocolFeeSats = marketFee(price),
    markerJson = transferMarker(ticker, input.atoms);
  const plan = finish(
    [input, ...ordinaryFunding(args.buyerFunding)],
    [
      output("sellerPayout", seller, price + sats(input.sats)),
      output("marker", markerScript(markerJson), 0n),
      output("recipient", args.buyerScriptHex, carrierSats, input.atoms),
      output("protocolFee", args.protocolScriptHex, protocolFeeSats),
    ],
    markerJson,
    args.changeScriptHex ?? args.buyerScriptHex,
    args.minerFeeSats,
    { sellerPayoutSats: price, buyerAtoms: input.atoms, protocolFeeSats },
  );
  return { ...plan, ...(args.offer ? { inputWitnesses: [args.offer.sellerWitnessHex] } : {}) };
}
export function buildCancel(args: {
  offer: Offer;
  funding: Input[];
  changeScriptHex?: string;
  minerFeeSats?: bigint;
}): Plan {
  verifyOffer(args.offer);
  const o = args.offer;
  return buildTransfer({
    network: o.network,
    deployTxid: o.deployTxid,
    ticker: o.ticker,
    input: o.listedInput,
    amountAtoms: o.listedInput.atoms,
    recipientScriptHex: o.sellerScriptHex,
    funding: args.funding,
    changeScriptHex: args.changeScriptHex ?? o.sellerScriptHex,
    minerFeeSats: args.minerFeeSats,
  });
}
