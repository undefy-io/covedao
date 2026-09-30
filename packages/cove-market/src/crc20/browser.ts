import * as bitcoin from "bitcoinjs-lib";
import { deterministicFee } from "@crclaunch/cove-economics";

export type CrcNetwork = "mainnet" | "testnet" | "signet" | "regtest";
export type CrcListing = Readonly<{
  id: string; network: CrcNetwork; deployTxid: string; ticker: string;
  sellerScriptHex: string; sellerPayoutScriptHex: string;
  sellerAnchorTxid: string; sellerAnchorVout: number; sellerAnchorSats: number;
  amountAtoms: bigint; priceSats: number; protocolFeeSats: number; expiresAtHeight: bigint;
}>;
export type IndexedCrcAsset = Readonly<{
  network: CrcNetwork; deployTxid: string; ticker: string; protocolVersion: number;
  tokenOutpoint: string | null; tokenScriptHex: string | null; tokenAtoms: bigint;
  protocolScriptHex: string; vaultScriptHex: string;
}>;
export type CrcFunding = Readonly<{
  txid: string; vout: number; valueSats: number; scriptHex: string;
  tokenAtoms: bigint; tokenDeploymentTxid?: string; publicKeyHex?: string;
}>;
export type CrcFillOptions = Readonly<{
  listing: CrcListing; asset: IndexedCrcAsset; sellerFunding: CrcFunding;
  buyerFunding: readonly CrcFunding[]; buyerScriptHex: string;
  buyerFundingScriptHex?: string; protocolScriptHex: string;
  recipientSats: number; minerFeeSats: number; currentHeight: bigint;
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function script(value: string): Buffer {
  assert(/^(?:[0-9a-f]{2})+$/i.test(value) && value.length <= 20000, "invalid market script");
  return Buffer.from(value, "hex");
}

function positiveSats(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function crcMarketFee(priceSats: number, feeBps: bigint, minFeeSats: bigint = 1_000n): number {
  assert(positiveSats(priceSats), "invalid sale price");
  const fee = deterministicFee(BigInt(priceSats), feeBps, 0n, minFeeSats);
  assert(fee <= BigInt(Number.MAX_SAFE_INTEGER), "market fee exceeds safe range");
  return Number(fee);
}

export function crcListingMessage(listing: CrcListing): string {
  return `Cove CRC marketplace listing v2\n${JSON.stringify({
    id: listing.id, network: listing.network, deployTxid: listing.deployTxid,
    ticker: listing.ticker, sellerScriptHex: listing.sellerScriptHex,
    sellerPayoutScriptHex: listing.sellerPayoutScriptHex,
    sellerAnchorTxid: listing.sellerAnchorTxid, sellerAnchorVout: listing.sellerAnchorVout,
    sellerAnchorSats: listing.sellerAnchorSats, amountAtoms: listing.amountAtoms.toString(),
    priceSats: listing.priceSats, protocolFeeSats: listing.protocolFeeSats,
    expiresAtHeight: listing.expiresAtHeight.toString(),
  })}`;
}

export function crcCancelMessage(listing: CrcListing): string {
  return `Cove CRC marketplace cancellation v2\n${listing.network}:${listing.deployTxid}:${listing.id}:${listing.sellerScriptHex}`;
}

export function validateCrcListing(listing: CrcListing, asset: IndexedCrcAsset, height: bigint): void {
  assert(/^[0-9a-f]{64}$/.test(listing.deployTxid), "invalid deployment id");
  assert(listing.network === asset.network && listing.deployTxid === asset.deployTxid,
    "deployment is not a registered Cove asset on this network");
  assert(asset.protocolVersion === 2 && asset.ticker === listing.ticker, "Cove v2 asset is unavailable");
  assert(listing.amountAtoms > 0n && asset.tokenAtoms === listing.amountAtoms &&
    asset.tokenOutpoint === `${listing.sellerAnchorTxid}:${listing.sellerAnchorVout}` &&
    asset.tokenScriptHex?.toLowerCase() === listing.sellerScriptHex.toLowerCase(),
  "listed token outpoint is missing or differs from indexed allocation");
  assert(listing.expiresAtHeight > height, "listing has expired");
  assert(/^[0-9a-f]{64}$/.test(listing.sellerAnchorTxid) &&
    Number.isSafeInteger(listing.sellerAnchorVout) && listing.sellerAnchorVout >= 0,
  "invalid seller anchor");
  assert(positiveSats(listing.sellerAnchorSats) && positiveSats(listing.priceSats) &&
    Number.isSafeInteger(listing.protocolFeeSats) && listing.protocolFeeSats >= 0,
  "invalid seller payout or fee");
  script(listing.sellerScriptHex); script(listing.sellerPayoutScriptHex);
  const sellerScript = script(listing.sellerScriptHex);
  assert((sellerScript.length === 22 && sellerScript[0] === 0 && sellerScript[1] === 0x14) ||
    (sellerScript.length === 34 && sellerScript[0] === 0x51 && sellerScript[1] === 0x20),
  "market seller token output must use a native SegWit or Taproot address");
  script(asset.protocolScriptHex); script(asset.vaultScriptHex);
  assert(listing.sellerScriptHex.toLowerCase() !== asset.vaultScriptHex.toLowerCase(),
    "vault token output cannot be listed as a peer sale");
  assert(listing.sellerScriptHex.toLowerCase() === listing.sellerPayoutScriptHex.toLowerCase(),
    "seller payout must use the token owner script");
}

function inputMetadata(coin: CrcFunding): { redeemScript: string | null; tapInternalKey: string | null } {
  const funding = script(coin.scriptHex);
  const nested = funding.length === 23 && funding[0] === 0xa9 && funding[1] === 0x14 && funding[22] === 0x87;
  const taproot = funding.length === 34 && funding[0] === 0x51 && funding[1] === 0x20;
  if (nested) {
    assert(coin.publicKeyHex && /^(02|03)[0-9a-f]{64}$/i.test(coin.publicKeyHex),
      "nested buyer funding needs a compressed public key");
    const witness = bitcoin.script.compile([bitcoin.opcodes.OP_0!, bitcoin.crypto.hash160(Buffer.from(coin.publicKeyHex, "hex"))]);
    const expected = bitcoin.script.compile([bitcoin.opcodes.OP_HASH160!, bitcoin.crypto.hash160(witness), bitcoin.opcodes.OP_EQUAL!]);
    assert(expected.equals(funding), "wallet public key does not match funding script");
    return { redeemScript: witness.toString("hex"), tapInternalKey: null };
  }
  if (taproot && coin.publicKeyHex) {
    assert(/^[0-9a-f]{64}$/i.test(coin.publicKeyHex), "invalid Taproot wallet public key");
    return { redeemScript: null, tapInternalKey: coin.publicKeyHex.toLowerCase() };
  }
  return { redeemScript: null, tapInternalKey: null };
}

export function verifyCrcFillTransaction(psbt: bitcoin.Psbt, options: CrcFillOptions): void {
  const { listing, asset, sellerFunding, buyerFunding } = options;
  validateCrcListing(listing, asset, options.currentHeight);
  assert(sellerFunding.txid === listing.sellerAnchorTxid &&
    sellerFunding.vout === listing.sellerAnchorVout &&
    sellerFunding.valueSats === listing.sellerAnchorSats &&
    sellerFunding.scriptHex.toLowerCase() === listing.sellerScriptHex.toLowerCase() &&
    sellerFunding.tokenAtoms === listing.amountAtoms &&
    sellerFunding.tokenDeploymentTxid === listing.deployTxid,
  "seller token outpoint does not match trusted funding");
  const fundingScript = options.buyerFundingScriptHex ?? options.buyerScriptHex;
  script(fundingScript); script(options.buyerScriptHex);
  assert(buyerFunding.length > 0 && buyerFunding.every((coin) =>
    coin.scriptHex.toLowerCase() === fundingScript.toLowerCase() &&
    coin.tokenAtoms === 0n && coin.tokenDeploymentTxid === undefined),
  "buyer funding must be token-free and belong to buyer script");
  assert(options.buyerScriptHex.toLowerCase() !== listing.sellerScriptHex.toLowerCase() &&
    options.buyerScriptHex.toLowerCase() !== asset.vaultScriptHex.toLowerCase(),
  "invalid market recipient");
  assert(options.protocolScriptHex.toLowerCase() === asset.protocolScriptHex.toLowerCase(),
    "market fee recipient differs from indexed deployment");
  assert(positiveSats(options.recipientSats) && Number.isSafeInteger(options.minerFeeSats) &&
    options.minerFeeSats >= 0, "invalid recipient value or miner fee");
  const coins = [sellerFunding, ...buyerFunding];
  const total = coins.reduce((sum, coin) => sum + BigInt(coin.valueSats), 0n);
  const required = BigInt(listing.sellerAnchorSats) + BigInt(listing.priceSats) +
    BigInt(listing.protocolFeeSats) + BigInt(options.recipientSats) + BigInt(options.minerFeeSats);
  const change = total - required;
  assert(change >= 0n && change <= BigInt(Number.MAX_SAFE_INTEGER), "funding is insufficient or unsafe");
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  assert(tx.version === 2 && tx.locktime === 0 && tx.ins.length === coins.length &&
    psbt.data.inputs.length === coins.length, "fill transaction changed from exact listing terms");
  const seen = new Set<string>();
  coins.forEach((coin, index) => {
    const actual = tx.ins[index]!;
    const outpoint = `${coin.txid.toLowerCase()}:${coin.vout}`;
    assert(!seen.has(outpoint), "duplicate market input"); seen.add(outpoint);
    assert(Buffer.from(actual.hash).reverse().toString("hex") === coin.txid.toLowerCase() &&
      actual.index === coin.vout && actual.sequence === 0xffffffff,
    "fill input changed from exact listing terms");
    const funding = psbt.data.inputs[index]!;
    const expected = inputMetadata(coin);
    assert(funding.witnessUtxo?.value === coin.valueSats &&
      funding.witnessUtxo.script.equals(script(coin.scriptHex)) &&
      funding.sighashType === bitcoin.Transaction.SIGHASH_ALL &&
      (funding.redeemScript?.toString("hex") ?? null) === expected.redeemScript &&
      (funding.tapInternalKey?.toString("hex") ?? null) === expected.tapInternalKey,
    "fill funding differs from trusted inputs");
  });
  const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({
    p: "crc-20", op: "transfer", tick: listing.ticker, amt: listing.amountAtoms.toString(),
    id: listing.deployTxid, v: 2,
  }), "utf8")]);
  const expectedOutputs = [
    { value: 0, script: marker },
    { value: options.recipientSats, script: script(options.buyerScriptHex) },
    { value: listing.sellerAnchorSats + listing.priceSats, script: script(listing.sellerScriptHex) },
    { value: listing.protocolFeeSats, script: script(asset.protocolScriptHex) },
    ...(change > 0n ? [{ value: Number(change), script: script(fundingScript) }] : []),
  ];
  assert(tx.outs.length === expectedOutputs.length && expectedOutputs.every((expected, index) =>
    tx.outs[index]!.value === expected.value && tx.outs[index]!.script.equals(expected.script)),
  "fill transaction changed from exact listing terms");
}
