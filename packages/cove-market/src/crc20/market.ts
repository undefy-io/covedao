import * as bitcoin from "bitcoinjs-lib";
import { checkSpendSignature } from "@crclaunch/bitcoin/spend";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { buildCoveV3MarketFill, buildUnsignedPsbt, type CoveV2Input } from "@crclaunch/crc20-transactions";
import { deterministicFee } from "@crclaunch/cove-economics";
import { verifyBip322 } from "../order/signature.js";

export type CrcNetwork = "mainnet" | "testnet" | "signet" | "regtest";

export type CrcListing = Readonly<{
  id: string;
  network: CrcNetwork;
  deployTxid: string;
  ticker: string;
  sellerScriptHex: string;
  sellerPayoutScriptHex: string;
  sellerAnchorTxid: string;
  sellerAnchorVout: number;
  sellerAnchorSats: number;
  amountAtoms: bigint;
  priceSats: number;
  protocolFeeSats: number;
  expiresAtHeight: bigint;
}>;

export type IndexedCrcAsset = Readonly<{
  network: CrcNetwork;
  deployTxid: string;
  ticker: string;
  protocolVersion: number;
  tokenOutpoint: string | null;
  tokenScriptHex: string | null;
  tokenAtoms: bigint;
  protocolScriptHex: string;
  vaultScriptHex: string;
}>;

export function crcMarketFee(priceSats: number, feeBps: bigint, minFeeSats: bigint = 1_000n): number {
  assert(safePositiveSats(priceSats), "invalid sale price");
  const fee = deterministicFee(BigInt(priceSats), feeBps, 0n, minFeeSats);
  assert(fee <= BigInt(Number.MAX_SAFE_INTEGER), "market fee exceeds safe range");
  return Number(fee);
}

export type CrcFillOptions = Readonly<{
  listing: CrcListing;
  asset: IndexedCrcAsset;
  sellerFunding: CoveV2Input;
  buyerFunding: readonly CoveV2Input[];
  buyerScriptHex: string;
  buyerFundingScriptHex?: string;
  protocolScriptHex: string;
  recipientSats: number;
  minerFeeSats: number;
  currentHeight: bigint;
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validHexScript(value: string): boolean {
  return /^(?:[0-9a-f]{2})+$/i.test(value) && value.length <= 20000;
}

function safePositiveSats(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateCrcListing(listing: CrcListing, asset: IndexedCrcAsset, currentHeight: bigint): void {
  assert(/^[0-9a-f]{64}$/.test(listing.deployTxid), "invalid deployment id");
  assert(listing.network === asset.network && listing.deployTxid === asset.deployTxid,
    "deployment is not a registered Cove asset on this network");
  assert(asset.protocolVersion === 3 && asset.ticker === listing.ticker, "Cove CRC asset is unavailable");
  assert(listing.amountAtoms > 0n && asset.tokenAtoms === listing.amountAtoms &&
    asset.tokenOutpoint === `${listing.sellerAnchorTxid}:${listing.sellerAnchorVout}` &&
    asset.tokenScriptHex?.toLowerCase() === listing.sellerScriptHex.toLowerCase(),
  "listed token outpoint is missing or differs from indexed allocation");
  assert(listing.expiresAtHeight > currentHeight, "listing has expired");
  assert(/^[0-9a-f]{64}$/.test(listing.sellerAnchorTxid) &&
    Number.isSafeInteger(listing.sellerAnchorVout) && listing.sellerAnchorVout >= 0,
  "invalid seller anchor");
  assert(safePositiveSats(listing.sellerAnchorSats) && safePositiveSats(listing.priceSats) &&
    Number.isSafeInteger(listing.protocolFeeSats) && listing.protocolFeeSats >= 0,
  "invalid seller payout or fee");
  assert(validHexScript(listing.sellerScriptHex) && validHexScript(listing.sellerPayoutScriptHex),
    "invalid seller script");
  const sellerScript = Buffer.from(listing.sellerScriptHex, "hex");
  assert((sellerScript.length === 22 && sellerScript[0] === 0 && sellerScript[1] === 0x14) ||
    (sellerScript.length === 34 && sellerScript[0] === 0x51 && sellerScript[1] === 0x20),
  "market seller token output must use a native SegWit or Taproot address");
  assert(validHexScript(asset.protocolScriptHex) && validHexScript(asset.vaultScriptHex),
    "registered Cove scripts are invalid");
  assert(listing.sellerScriptHex.toLowerCase() !== asset.vaultScriptHex.toLowerCase(),
    "vault token output cannot be listed as a peer sale");
  assert(listing.sellerScriptHex.toLowerCase() === listing.sellerPayoutScriptHex.toLowerCase(),
    "seller payout must use the token owner script");
}

export function crcListingMessage(listing: CrcListing): string {
  return `Cove CRC marketplace listing v3\n${JSON.stringify({
    id: listing.id,
    network: listing.network,
    deployTxid: listing.deployTxid,
    ticker: listing.ticker,
    sellerScriptHex: listing.sellerScriptHex,
    sellerPayoutScriptHex: listing.sellerPayoutScriptHex,
    sellerAnchorTxid: listing.sellerAnchorTxid,
    sellerAnchorVout: listing.sellerAnchorVout,
    sellerAnchorSats: listing.sellerAnchorSats,
    amountAtoms: listing.amountAtoms.toString(),
    priceSats: listing.priceSats,
    protocolFeeSats: listing.protocolFeeSats,
    expiresAtHeight: listing.expiresAtHeight.toString(),
  })}`;
}

export function verifyCrcListingAuthorization(listing: CrcListing, signatureB64: string): void {
  assert(verifyBip322(Buffer.from(listing.sellerScriptHex, "hex"), crcListingMessage(listing), signatureB64),
    "seller did not authorize listing terms");
}

export function crcCancelMessage(listing: CrcListing): string {
  return `Cove CRC marketplace cancellation v3\n${listing.network}:${listing.deployTxid}:${listing.id}:${listing.sellerScriptHex}`;
}

export function verifyCrcCancellation(listing: CrcListing, signatureB64: string): void {
  assert(verifyBip322(Buffer.from(listing.sellerScriptHex, "hex"), crcCancelMessage(listing), signatureB64),
    "seller did not authorize cancellation");
}

function networkParams(network: CrcNetwork): bitcoin.networks.Network {
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  if (network === "regtest") return bitcoin.networks.regtest;
  return bitcoin.networks.testnet;
}

function expectedFill(options: CrcFillOptions): bitcoin.Psbt {
  const { listing, asset, sellerFunding, buyerFunding } = options;
  validateCrcListing(listing, asset, options.currentHeight);
  assert(sellerFunding.txid === listing.sellerAnchorTxid &&
    sellerFunding.vout === listing.sellerAnchorVout &&
    sellerFunding.valueSats === listing.sellerAnchorSats &&
    sellerFunding.scriptHex.toLowerCase() === listing.sellerScriptHex.toLowerCase() &&
    sellerFunding.tokenAtoms === listing.amountAtoms &&
    sellerFunding.tokenDeploymentTxid === listing.deployTxid,
  "seller token outpoint does not match trusted funding");
  const fundingScriptHex = options.buyerFundingScriptHex ?? options.buyerScriptHex;
  assert(validHexScript(fundingScriptHex), "buyer funding script is invalid");
  assert(buyerFunding.length > 0 && buyerFunding.every((input) =>
    input.scriptHex.toLowerCase() === fundingScriptHex.toLowerCase() &&
    input.tokenAtoms === 0n && input.tokenDeploymentTxid === undefined),
  "buyer funding must be token-free and belong to buyer script");
  assert(options.buyerScriptHex.toLowerCase() !== listing.sellerScriptHex.toLowerCase(),
    "self fills are not supported");
  assert(options.buyerScriptHex.toLowerCase() !== asset.vaultScriptHex.toLowerCase(),
    "vault script cannot receive a peer market fill");
  assert(options.protocolScriptHex.toLowerCase() === asset.protocolScriptHex.toLowerCase(),
    "market fee recipient differs from indexed deployment");
  assert(safePositiveSats(options.recipientSats) && Number.isSafeInteger(options.minerFeeSats) &&
    options.minerFeeSats >= 0, "invalid recipient value or miner fee");
  const inputSats = [sellerFunding, ...buyerFunding].reduce((sum, input) => sum + BigInt(input.valueSats), 0n);
  const requiredSats = BigInt(options.recipientSats) + BigInt(listing.priceSats) +
    BigInt(listing.sellerAnchorSats) + BigInt(listing.protocolFeeSats) + BigInt(options.minerFeeSats);
  assert(inputSats >= requiredSats, "funding is insufficient");
  const change = inputSats - requiredSats;
  assert(change <= BigInt(Number.MAX_SAFE_INTEGER), "change exceeds safe range");
  const template = buildCoveV3MarketFill({
    ticker: listing.ticker,
    deploymentTxid: listing.deployTxid,
    listedInput: sellerFunding,
    buyerScriptHex: options.buyerScriptHex,
    recipientSats: options.recipientSats,
    sellerNetPriceSats: listing.priceSats,
    protocolScriptHex: options.protocolScriptHex,
    protocolFeeSats: listing.protocolFeeSats,
    buyerChangeSats: Number(change),
    buyerChangeScriptHex: fundingScriptHex,
  });
  return buildUnsignedPsbt(template, [sellerFunding, ...buyerFunding], options.minerFeeSats,
    networkParams(listing.network));
}

export function createCrcFill(options: CrcFillOptions): { psbt: bitcoin.Psbt } {
  return { psbt: expectedFill(options) };
}

export async function verifyCurrentCrcFunding(
  core: Pick<CoreRpcProvider, "getTxout">,
  options: Pick<CrcFillOptions, "sellerFunding" | "buyerFunding">,
): Promise<void> {
  const seen = new Set<string>();
  for (const input of [options.sellerFunding, ...options.buyerFunding]) {
    const outpoint = `${input.txid.toLowerCase()}:${input.vout}`;
    assert(!seen.has(outpoint), "duplicate funding input");
    seen.add(outpoint);
    const current = await core.getTxout(input.txid, input.vout, true);
    assert(current && current.scriptPubKeyHex.toLowerCase() === input.scriptHex.toLowerCase() &&
      current.valueSats === BigInt(input.valueSats), "funding anchor is spent or differs from Core");
  }
}

export function verifyCrcFillTransaction(psbt: bitcoin.Psbt, options: CrcFillOptions): void {
  const expected = expectedFill(options);
  assert(psbt.data.globalMap.unsignedTx.toBuffer().equals(expected.data.globalMap.unsignedTx.toBuffer()),
    "fill transaction changed from exact listing terms");
  assert(psbt.data.inputs.length === expected.data.inputs.length, "fill input count changed");
  for (let index = 0; index < expected.data.inputs.length; index++) {
    const actual = psbt.data.inputs[index]!;
    const trusted = expected.data.inputs[index]!;
    assert(actual.witnessUtxo?.value === trusted.witnessUtxo?.value &&
      actual.witnessUtxo?.script.equals(trusted.witnessUtxo!.script) &&
      (actual.redeemScript?.toString("hex") ?? null) === (trusted.redeemScript?.toString("hex") ?? null) &&
      (actual.tapInternalKey?.toString("hex") ?? null) === (trusted.tapInternalKey?.toString("hex") ?? null),
    "fill funding differs from trusted inputs");
    assert(actual.sighashType === bitcoin.Transaction.SIGHASH_ALL,
      "fill input must use SIGHASH_ALL");
  }
}

export function verifyCrcFillSignatures(psbt: bitcoin.Psbt, buyerInputCount: number): void {
  assert(psbt.data.inputs.length === buyerInputCount + 1 && buyerInputCount > 0,
    "seller and buyer input count mismatch");
  for (let index = 0; index < psbt.data.inputs.length; index++) {
    const result = checkSpendSignature(psbt, index);
    assert(result.ok, `input ${index}: ${result.ok ? "" : result.detail}`);
  }
}
