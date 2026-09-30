import * as bitcoin from "bitcoinjs-lib";
import { parseCrc20Transaction, type TxOutput } from "@crclaunch/crc20-base";
import { quoteBuy, quoteSell, type CurveState } from "@crclaunch/crc20-curve";
import { dustThreshold } from "@crclaunch/cove-economics";
import {
  buildCrc20AssetVault,
  crc20DeploymentTag,
  type CoveVault,
  type VaultRecoveryProfile,
} from "@crclaunch/cove-vault";

const COVE_V1_MAX_ATOMS = "2100000000000000";
const COVE_V1_CREATOR_RECORD_SATS = 1_000;
const COVE_V1_LAUNCH_FEE_SATS = 7_000;

export type ScriptSet = Readonly<{
  buyer: string;
  seller: string;
  vault: string;
  protocol: string;
  creator: string;
}>;

export type FundingInput = Readonly<{
  txid: string;
  vout: number;
  valueSats: number;
  scriptHex: string;
  publicKeyHex?: string;
}>;

export type CoveV2Input = FundingInput & Readonly<{
  tokenAtoms: bigint;
  tokenDeploymentTxid?: string;
}>;

export type TxTemplate = Readonly<{
  operation: "deploy" | "mint" | "transfer";
  tx: bitcoin.Transaction;
  outputs: readonly TxOutput[];
  markerBytes: number;
  requiredFundingSats: number;
  previousVaultOutpoint?: string;
  requiredFirstInputScriptHex?: string;
  requiredInputs?: readonly CoveV2Input[];
  v2DeploymentTxid?: string;
  tokenChangeAtoms?: bigint;
}>;

function safeSats(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("satoshi value out of range");
  return Number(value);
}

function checkScript(scriptHex: string): void {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(scriptHex)) throw new Error("invalid payment script");
  const script = Buffer.from(scriptHex, "hex");
  const witness =
    (script.length === 22 && script[0] === 0 && script[1] === 0x14) ||
    (script.length === 34 && script[0] === 0 && script[1] === 0x20) ||
    (script.length === 34 && script[0] === 0x51 && script[1] === 0x20);
  const p2pkh =
    script.length === 25 &&
    script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 &&
    script[23] === 0x88 && script[24] === 0xac;
  const p2sh = script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87;
  if (!witness && !p2pkh && !p2sh) throw new Error("unsupported payment script");
}

function marker(payload: Record<string, string | number>): { output: TxOutput; bytes: number } {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  if (data.length > 256) throw new Error("Cove marker exceeds 256-byte payload limit");
  const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, data]);
  return { output: { valueSats: 0, scriptHex: script.toString("hex") }, bytes: data.length };
}

function template(
  operation: TxTemplate["operation"],
  payload: Record<string, string | number>,
  following: readonly TxOutput[],
  requiredFundingSats: number,
  previousVaultOutpoint?: string,
): TxTemplate {
  const encoded = marker(payload);
  const outputs = [encoded.output, ...following];
  for (const output of following) {
    checkScript(output.scriptHex);
    if (!Number.isSafeInteger(output.valueSats) ||
      BigInt(output.valueSats) < dustThreshold(Buffer.from(output.scriptHex, "hex"))) {
      throw new Error("payment output is below its script dust threshold");
    }
  }
  const parsed = parseCrc20Transaction(outputs);
  if (parsed.status !== "valid" || parsed.envelope.kind !== operation) {
    throw new Error(`CRC marker does not parse as ${operation}`);
  }
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const output of outputs)
    tx.addOutput(Buffer.from(output.scriptHex, "hex"), output.valueSats);
  return {
    operation,
    tx,
    outputs,
    markerBytes: encoded.bytes,
    requiredFundingSats,
    previousVaultOutpoint,
  };
}

export function buildCurveDeploy(params: {
  ticker: string;
  maxAtoms: string;
  scripts: Pick<ScriptSet, "vault" | "creator" | "protocol">;
  vaultAnchorSats: number;
  changeSats?: number;
  changeScriptHex?: string;
}): TxTemplate {
  if (params.maxAtoms !== COVE_V1_MAX_ATOMS) throw new Error("invalid maximum supply for Cove v1");
  const change = finalChange(params.changeSats, params.changeScriptHex);
  return template(
    "deploy",
    curveDeployPayload(params.ticker),
    [
      { valueSats: params.vaultAnchorSats, scriptHex: params.scripts.vault },
      { valueSats: COVE_V1_CREATOR_RECORD_SATS, scriptHex: params.scripts.creator },
      { valueSats: COVE_V1_LAUNCH_FEE_SATS, scriptHex: params.scripts.protocol },
      ...change,
    ],
    params.vaultAnchorSats + COVE_V1_CREATOR_RECORD_SATS + COVE_V1_LAUNCH_FEE_SATS + (params.changeSats ?? 0),
  );
}

function curveDeployPayload(ticker: string): Record<string, string> {
  return { p: "crc-20", op: "deploy", tick: ticker, type: "bonding", max: COVE_V1_MAX_ATOMS, cv: "cove-curve-v1" };
}

function finalChange(changeSats: number | undefined, scriptHex: string | undefined): TxOutput[] {
  if (changeSats === undefined || changeSats === 0) return [];
  if (!Number.isSafeInteger(changeSats) || changeSats < 0 || !scriptHex) {
    throw new Error("invalid wallet change output");
  }
  return [{ valueSats: changeSats, scriptHex }];
}

export function buildCoveDeployWithVault(params: {
  ticker: string;
  launchSalt: Buffer;
  guardianXOnly: Buffer;
  recoveryProfile: VaultRecoveryProfile;
  creatorScriptHex: string;
  protocolScriptHex: string;
  vaultAnchorSats: number;
  changeSats?: number;
  changeScriptHex?: string;
  network?: bitcoin.networks.Network;
}): { template: TxTemplate; vault: CoveVault } {
  const markerBytes = Buffer.from(JSON.stringify(curveDeployPayload(params.ticker)), "utf8");
  const vault = buildCrc20AssetVault({
    asset: { deploymentTag: crc20DeploymentTag(markerBytes), launchSalt: params.launchSalt },
    guardianXOnly: params.guardianXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const template = buildCurveDeploy({
    ticker: params.ticker,
    maxAtoms: COVE_V1_MAX_ATOMS,
    scripts: { vault: vault.scriptPubKey.toString("hex"), creator: params.creatorScriptHex, protocol: params.protocolScriptHex },
    vaultAnchorSats: params.vaultAnchorSats,
    changeSats: params.changeSats,
    changeScriptHex: params.changeScriptHex,
  });
  return { template, vault };
}

export function buildCurveBuy(params: {
  ticker: string;
  deploymentTxid: string;
  state: CurveState;
  amountTokens: bigint;
  scripts: ScriptSet;
  recipientSats: number;
  changeSats?: number;
  changeScriptHex?: string;
}): TxTemplate {
  if (!/^[0-9a-f]{64}$/.test(params.deploymentTxid)) throw new Error("invalid deployment txid");
  const quote = quoteBuy(params.state, params.amountTokens);
  const payload =
    quote.operation === "mint"
      ? { p: "crc-20", op: "mint", tick: params.ticker, amt: quote.amountAtoms.toString(), id: params.deploymentTxid }
      : { p: "crc-20", op: "transfer", tick: params.ticker, amt: quote.amountAtoms.toString(), id: params.deploymentTxid };
  return template(
    quote.operation,
    payload,
    [
      { valueSats: params.recipientSats, scriptHex: params.scripts.buyer },
      {
        valueSats: safeSats(params.state.vaultSats + quote.grossSats),
        scriptHex: params.scripts.vault,
      },
      { valueSats: safeSats(quote.protocolFeeSats), scriptHex: params.scripts.protocol },
      { valueSats: safeSats(quote.creatorFeeSats), scriptHex: params.scripts.creator },
      ...finalChange(params.changeSats, params.changeScriptHex ?? params.scripts.buyer),
    ],
    safeSats(
      quote.grossSats + quote.protocolFeeSats + quote.creatorFeeSats + BigInt(params.recipientSats) + BigInt(params.changeSats ?? 0),
    ),
    params.state.vaultOutpoint,
  );
}

export function buildCurveSell(params: {
  ticker: string;
  deploymentTxid: string;
  state: CurveState;
  amountTokens: bigint;
  scripts: ScriptSet;
  changeSats?: number;
  sellerPayoutScriptHex?: string;
  changeScriptHex?: string;
}): TxTemplate {
  if (!/^[0-9a-f]{64}$/.test(params.deploymentTxid)) throw new Error("invalid deployment txid");
  const payoutScriptHex = params.sellerPayoutScriptHex ?? params.scripts.seller;
  const quote = quoteSell(
    params.state,
    params.amountTokens,
    dustThreshold(Buffer.from(payoutScriptHex, "hex")),
  );
  return template(
    "transfer",
    { p: "crc-20", op: "transfer", tick: params.ticker, amt: quote.amountAtoms.toString(), id: params.deploymentTxid },
    [
      {
        valueSats: safeSats(params.state.vaultSats - quote.grossSats),
        scriptHex: params.scripts.vault,
      },
      { valueSats: safeSats(quote.sellerPayoutSats), scriptHex: payoutScriptHex },
      { valueSats: safeSats(quote.protocolFeeSats), scriptHex: params.scripts.protocol },
      ...finalChange(params.changeSats, params.changeScriptHex ?? payoutScriptHex),
    ],
    safeSats(quote.walletTopUpSats + BigInt(params.changeSats ?? 0)),
    params.state.vaultOutpoint,
  );
}

export function buildCoveTransfer(params: {
  ticker: string;
  deploymentTxid: string;
  amountAtoms: bigint;
  senderScriptHex: string;
  recipientScriptHex: string;
  recipientSats: number;
  changeSats?: number;
}): TxTemplate {
  if (!/^[0-9a-f]{64}$/.test(params.deploymentTxid)) throw new Error("invalid deployment txid");
  if (params.amountAtoms <= 0n) throw new Error("transfer amount must be positive");
  const changeSats = params.changeSats ?? 0;
  if (!Number.isSafeInteger(changeSats) || changeSats < 0) throw new Error("invalid change amount");
  const outputs: TxOutput[] = [{ valueSats: params.recipientSats, scriptHex: params.recipientScriptHex }];
  if (changeSats > 0) outputs.push({ valueSats: changeSats, scriptHex: params.senderScriptHex });
  return template(
    "transfer",
    { p: "crc-20", op: "transfer", tick: params.ticker, amt: params.amountAtoms.toString(), id: params.deploymentTxid },
    outputs,
    safeSats(BigInt(params.recipientSats) + BigInt(changeSats)),
  );
}

export function buildCoveMarketFill(params: {
  ticker: string;
  deploymentTxid: string;
  amountAtoms: bigint;
  sellerScriptHex: string;
  buyerScriptHex: string;
  recipientSats: number;
  sellerPayoutSats: number;
  protocolScriptHex: string;
  protocolFeeSats: number;
  buyerChangeSats?: number;
}): TxTemplate {
  if (!/^[0-9a-f]{64}$/.test(params.deploymentTxid)) throw new Error("invalid deployment txid");
  if (params.amountAtoms <= 0n) throw new Error("market amount must be positive");
  const outputs: TxOutput[] = [
    { valueSats: params.recipientSats, scriptHex: params.buyerScriptHex },
    { valueSats: params.sellerPayoutSats, scriptHex: params.sellerScriptHex },
    { valueSats: params.protocolFeeSats, scriptHex: params.protocolScriptHex },
    ...finalChange(params.buyerChangeSats, params.buyerScriptHex),
  ];
  const built = template(
    "transfer",
    { p: "crc-20", op: "transfer", tick: params.ticker, amt: params.amountAtoms.toString(), id: params.deploymentTxid },
    outputs,
    safeSats(outputs.reduce((sum, output) => sum + BigInt(output.valueSats), 0n)),
  );
  return { ...built, requiredFirstInputScriptHex: params.sellerScriptHex };
}

function checkV2Identity(deploymentTxid: string): void {
  if (!/^[0-9a-f]{64}$/.test(deploymentTxid)) throw new Error("invalid v2 deployment txid");
}

function checkV2Input(input: CoveV2Input, deploymentTxid: string, mustBearTokens: boolean): void {
  if (!/^[0-9a-fA-F]{64}$/.test(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0 ||
    !Number.isSafeInteger(input.valueSats) || input.valueSats < 0) throw new Error("invalid token input outpoint");
  checkScript(input.scriptHex);
  if (typeof input.tokenAtoms !== "bigint" || input.tokenAtoms < 0n) throw new Error("invalid token input amount");
  if (mustBearTokens && input.tokenAtoms === 0n) throw new Error("token input has no allocation");
  if (input.tokenAtoms > 0n && BigInt(input.valueSats) < dustThreshold(Buffer.from(input.scriptHex, "hex"))) {
    throw new Error("token input carrier is below dust threshold");
  }
  if (input.tokenAtoms > 0n && input.tokenDeploymentTxid !== deploymentTxid) {
    throw new Error("token input belongs to a different asset");
  }
  if (input.tokenAtoms === 0n && input.tokenDeploymentTxid !== undefined) {
    throw new Error("zero token input has asset metadata");
  }
}

function checkV2TokenInputs(inputs: readonly CoveV2Input[], deploymentTxid: string, ownerScriptHex?: string): bigint {
  if (inputs.length === 0) throw new Error("at least one token input is required");
  const seen = new Set<string>();
  let atoms = 0n;
  for (const input of inputs) {
    checkV2Input(input, deploymentTxid, true);
    const outpoint = `${input.txid.toLowerCase()}:${input.vout}`;
    if (seen.has(outpoint)) throw new Error("duplicate token outpoint");
    seen.add(outpoint);
    if (ownerScriptHex && input.scriptHex.toLowerCase() !== ownerScriptHex.toLowerCase()) {
      throw new Error("token inputs must have one owner script");
    }
    atoms += input.tokenAtoms;
  }
  return atoms;
}

function v2Payload(operation: "mint" | "transfer", ticker: string, amountAtoms: bigint, deploymentTxid: string, ch?: number): Record<string, string | number> {
  checkV2Identity(deploymentTxid);
  if (amountAtoms <= 0n) throw new Error("token amount must be positive");
  return { p: "crc-20", op: operation, tick: ticker, amt: amountAtoms.toString(), id: deploymentTxid, v: 2,
    ...(ch === undefined ? {} : { ch }) };
}

function v2Template(
  operation: "mint" | "transfer",
  payload: Record<string, string | number>,
  outputs: readonly TxOutput[],
  requiredInputs: readonly CoveV2Input[],
  deploymentTxid: string,
  tokenChangeAtoms = 0n,
  previousVaultOutpoint?: string,
): TxTemplate {
  const inputTotal = requiredInputs.reduce((sum, input) => sum + BigInt(input.valueSats), 0n);
  const outputTotal = outputs.reduce((sum, output) => sum + BigInt(output.valueSats), 0n);
  if (outputTotal < inputTotal) throw new Error("mandatory input sats exceed outputs; add explicit BTC change");
  const built = template(operation, payload, outputs, safeSats(outputTotal - inputTotal), previousVaultOutpoint);
  return { ...built, requiredInputs, v2DeploymentTxid: deploymentTxid, tokenChangeAtoms };
}

export function buildCurveDeployV2(params: {
  ticker: string;
  maxAtoms: string;
  scripts: Pick<ScriptSet, "vault" | "creator" | "protocol">;
  vaultAnchorSats: number;
  changeSats?: number;
  changeScriptHex?: string;
}): TxTemplate {
  if (params.maxAtoms !== COVE_V1_MAX_ATOMS) throw new Error("invalid maximum supply for Cove v2");
  return template("deploy", { p: "crc-20", op: "deploy", tick: params.ticker, type: "bonding",
    max: COVE_V1_MAX_ATOMS, cv: "cove-curve-v2" }, [
    { valueSats: params.vaultAnchorSats, scriptHex: params.scripts.vault },
    { valueSats: COVE_V1_CREATOR_RECORD_SATS, scriptHex: params.scripts.creator },
    { valueSats: COVE_V1_LAUNCH_FEE_SATS, scriptHex: params.scripts.protocol },
    ...finalChange(params.changeSats, params.changeScriptHex),
  ], params.vaultAnchorSats + COVE_V1_CREATOR_RECORD_SATS + COVE_V1_LAUNCH_FEE_SATS + (params.changeSats ?? 0));
}

export function buildCoveDeployWithVaultV2(params: {
  ticker: string;
  launchSalt: Buffer;
  guardianXOnly: Buffer;
  recoveryProfile: VaultRecoveryProfile;
  creatorScriptHex: string;
  protocolScriptHex: string;
  vaultAnchorSats: number;
  changeSats?: number;
  changeScriptHex?: string;
  network?: bitcoin.networks.Network;
}): { template: TxTemplate; vault: CoveVault } {
  const deployPayload = { p: "crc-20", op: "deploy", tick: params.ticker, type: "bonding",
    max: COVE_V1_MAX_ATOMS, cv: "cove-curve-v2" };
  const vault = buildCrc20AssetVault({
    asset: { deploymentTag: crc20DeploymentTag(Buffer.from(JSON.stringify(deployPayload), "utf8")), launchSalt: params.launchSalt },
    guardianXOnly: params.guardianXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  return { vault, template: buildCurveDeployV2({ ticker: params.ticker, maxAtoms: COVE_V1_MAX_ATOMS,
    scripts: { vault: vault.scriptPubKey.toString("hex"), creator: params.creatorScriptHex,
      protocol: params.protocolScriptHex }, vaultAnchorSats: params.vaultAnchorSats,
    changeSats: params.changeSats, changeScriptHex: params.changeScriptHex }) };
}

export function buildCoveV2Transfer(params: {
  ticker: string;
  deploymentTxid: string;
  amountAtoms: bigint;
  tokenInputs: readonly CoveV2Input[];
  recipientScriptHex: string;
  recipientSats: number;
  tokenChangeSats?: number;
  btcChangeSats?: number;
  btcChangeScriptHex?: string;
}): TxTemplate {
  checkV2Identity(params.deploymentTxid);
  const owner = params.tokenInputs[0]?.scriptHex;
  const total = checkV2TokenInputs(params.tokenInputs, params.deploymentTxid, owner);
  if (total < params.amountAtoms) throw new Error("insufficient token input allocation");
  const remainder = total - params.amountAtoms;
  if (remainder > 0n && params.tokenChangeSats === undefined) throw new Error("token change output is required");
  if (remainder === 0n && params.tokenChangeSats !== undefined) throw new Error("token change output is not allowed");
  const outputs = [
    { valueSats: params.recipientSats, scriptHex: params.recipientScriptHex },
    ...(remainder > 0n ? [{ valueSats: params.tokenChangeSats!, scriptHex: owner! }] : []),
    ...finalChange(params.btcChangeSats, params.btcChangeScriptHex),
  ];
  return v2Template("transfer", v2Payload("transfer", params.ticker, params.amountAtoms,
    params.deploymentTxid, remainder > 0n ? 2 : undefined), outputs,
    params.tokenInputs, params.deploymentTxid, remainder);
}

export function buildCoveV2MarketFill(params: {
  ticker: string;
  deploymentTxid: string;
  listedInput: CoveV2Input;
  buyerScriptHex: string;
  recipientSats: number;
  sellerNetPriceSats: number;
  protocolScriptHex: string;
  protocolFeeSats: number;
  buyerChangeSats?: number;
}): TxTemplate {
  checkV2Input(params.listedInput, params.deploymentTxid, true);
  if (!Number.isSafeInteger(params.sellerNetPriceSats) || params.sellerNetPriceSats < 0) {
    throw new Error("invalid seller net price");
  }
  const payout = safeSats(BigInt(params.listedInput.valueSats) + BigInt(params.sellerNetPriceSats));
  const outputs = [
    { valueSats: params.recipientSats, scriptHex: params.buyerScriptHex },
    { valueSats: payout, scriptHex: params.listedInput.scriptHex },
    { valueSats: params.protocolFeeSats, scriptHex: params.protocolScriptHex },
    ...finalChange(params.buyerChangeSats, params.buyerScriptHex),
  ];
  return v2Template("transfer", v2Payload("transfer", params.ticker, params.listedInput.tokenAtoms,
    params.deploymentTxid), outputs, [params.listedInput], params.deploymentTxid);
}

export function buildCurveBuyV2(params: {
  ticker: string;
  deploymentTxid: string;
  state: CurveState;
  amountTokens: bigint;
  scripts: ScriptSet;
  recipientSats: number;
  vaultInput: CoveV2Input;
  changeSats?: number;
  changeScriptHex?: string;
}): TxTemplate {
  checkV2Identity(params.deploymentTxid);
  const quote = quoteBuy(params.state, params.amountTokens);
  checkV2Input(params.vaultInput, params.deploymentTxid, quote.operation === "transfer");
  if (`${params.vaultInput.txid}:${params.vaultInput.vout}` !== params.state.vaultOutpoint ||
    params.vaultInput.scriptHex.toLowerCase() !== params.scripts.vault.toLowerCase() ||
    BigInt(params.vaultInput.valueSats) !== params.state.vaultSats ||
    params.vaultInput.tokenAtoms !== params.state.vaultAtoms) {
    throw new Error("vault inventory or outpoint mismatch");
  }
  const outputs = [
    { valueSats: params.recipientSats, scriptHex: params.scripts.buyer },
    { valueSats: safeSats(params.state.vaultSats + quote.grossSats), scriptHex: params.scripts.vault },
    { valueSats: safeSats(quote.protocolFeeSats), scriptHex: params.scripts.protocol },
    { valueSats: safeSats(quote.creatorFeeSats), scriptHex: params.scripts.creator },
    ...finalChange(params.changeSats, params.changeScriptHex ?? params.scripts.buyer),
  ];
  return v2Template(quote.operation, v2Payload(quote.operation, params.ticker, quote.amountAtoms,
    params.deploymentTxid), outputs, [params.vaultInput], params.deploymentTxid, 0n, params.state.vaultOutpoint);
}

export function buildCurveSellV2(params: {
  ticker: string;
  deploymentTxid: string;
  state: CurveState;
  amountTokens: bigint;
  scripts: ScriptSet;
  vaultInput: CoveV2Input;
  sellerTokenInputs: readonly CoveV2Input[];
  tokenChangeSats?: number;
  changeSats?: number;
  sellerPayoutScriptHex?: string;
  changeScriptHex?: string;
}): TxTemplate {
  checkV2Identity(params.deploymentTxid);
  checkV2Input(params.vaultInput, params.deploymentTxid, params.state.vaultAtoms > 0n);
  if (`${params.vaultInput.txid}:${params.vaultInput.vout}` !== params.state.vaultOutpoint ||
    params.vaultInput.scriptHex.toLowerCase() !== params.scripts.vault.toLowerCase() ||
    BigInt(params.vaultInput.valueSats) !== params.state.vaultSats ||
    params.vaultInput.tokenAtoms !== params.state.vaultAtoms) {
    throw new Error("vault inventory or outpoint mismatch");
  }
  const total = checkV2TokenInputs(params.sellerTokenInputs, params.deploymentTxid, params.scripts.seller);
  if (total > params.state.circulatingAtoms) throw new Error("seller token inputs exceed circulating supply");
  const payoutScript = params.sellerPayoutScriptHex ?? params.scripts.seller;
  const quote = quoteSell(params.state, params.amountTokens, dustThreshold(Buffer.from(payoutScript, "hex")));
  if (total < quote.amountAtoms) throw new Error("insufficient seller token allocation");
  const remainder = total - quote.amountAtoms;
  if (remainder > 0n && params.tokenChangeSats === undefined) throw new Error("token change output is required");
  if (remainder === 0n && params.tokenChangeSats !== undefined) throw new Error("token change output is not allowed");
  const outputs = [
    { valueSats: safeSats(params.state.vaultSats - quote.grossSats), scriptHex: params.scripts.vault },
    { valueSats: safeSats(quote.sellerPayoutSats), scriptHex: payoutScript },
    { valueSats: safeSats(quote.protocolFeeSats), scriptHex: params.scripts.protocol },
    ...(remainder > 0n ? [{ valueSats: params.tokenChangeSats!, scriptHex: params.scripts.seller }] : []),
    ...finalChange(params.changeSats, params.changeScriptHex ?? payoutScript),
  ];
  return v2Template("transfer", v2Payload("transfer", params.ticker, quote.amountAtoms,
    params.deploymentTxid, remainder > 0n ? 4 : undefined), outputs,
    [params.vaultInput, ...params.sellerTokenInputs], params.deploymentTxid, remainder, params.state.vaultOutpoint);
}

export function buildUnsignedPsbt(
  txTemplate: TxTemplate,
  inputs: readonly FundingInput[],
  minerFeeSats: number,
  network: bitcoin.networks.Network = bitcoin.networks.regtest,
): bitcoin.Psbt {
  if (!Number.isSafeInteger(minerFeeSats) || minerFeeSats < 0) throw new Error("invalid miner fee");
  if (txTemplate.previousVaultOutpoint) {
    const first = inputs[0];
    if (!first || `${first.txid}:${first.vout}` !== txTemplate.previousVaultOutpoint) {
      throw new Error("first input must be the current vault input");
    }
  }
  if (txTemplate.requiredFirstInputScriptHex &&
    inputs[0]?.scriptHex.toLowerCase() !== txTemplate.requiredFirstInputScriptHex.toLowerCase()) {
    throw new Error("first input must be the seller input");
  }
  if (txTemplate.v2DeploymentTxid) {
    const mandatory = txTemplate.requiredInputs ?? [];
    for (let index = 0; index < mandatory.length; index++) {
      const expected = mandatory[index]!;
      const actual = inputs[index] as CoveV2Input | undefined;
      if (!actual || actual.txid.toLowerCase() !== expected.txid.toLowerCase() ||
        actual.vout !== expected.vout || actual.valueSats !== expected.valueSats ||
        actual.scriptHex.toLowerCase() !== expected.scriptHex.toLowerCase() ||
        actual.tokenAtoms !== expected.tokenAtoms ||
        actual.tokenDeploymentTxid !== expected.tokenDeploymentTxid) {
        throw new Error("required token input prefix or order mismatch");
      }
    }
    for (const funding of inputs.slice(mandatory.length)) {
      const annotated = funding as CoveV2Input;
      if (annotated.tokenAtoms !== 0n || annotated.tokenDeploymentTxid !== undefined) {
        throw new Error("token-bearing input cannot be ordinary BTC funding");
      }
    }
  }
  const seen = new Set<string>();
  let inputSats = 0n;
  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);
  for (const input of inputs) {
    const outpoint = `${input.txid}:${input.vout}`;
    if (
      !/^[0-9a-fA-F]{64}$/.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      seen.has(outpoint)
    ) {
      throw new Error("invalid or duplicate input outpoint");
    }
    seen.add(outpoint);
    checkScript(input.scriptHex);
    const fundingScript = Buffer.from(input.scriptHex, "hex");
    const p2wpkh = fundingScript.length === 22 && fundingScript[0] === 0 && fundingScript[1] === 0x14;
    const p2tr = fundingScript.length === 34 && fundingScript[0] === 0x51 && fundingScript[1] === 0x20;
    const p2sh = fundingScript.length === 23 && fundingScript[0] === 0xa9 && fundingScript[1] === 0x14 && fundingScript[22] === 0x87;
    if (!p2wpkh && !p2tr && !p2sh) {
      throw new Error("unsupported funding script without full parent transaction");
    }
    let redeemScript: Buffer | undefined;
    let tapInternalKey: Buffer | undefined;
    if (p2sh) {
      if (!input.publicKeyHex || !/^(02|03)[0-9a-fA-F]{64}$/.test(input.publicKeyHex)) {
        throw new Error("nested SegWit funding requires a compressed wallet public key");
      }
      const pubkey = Buffer.from(input.publicKeyHex, "hex");
      const nested = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network }), network });
      if (!nested.output?.equals(fundingScript) || !nested.redeem?.output) {
        throw new Error("wallet public key does not match funding script");
      }
      redeemScript = nested.redeem.output;
    }
    if (p2tr && input.publicKeyHex) {
      if (!/^[0-9a-fA-F]{64}$/.test(input.publicKeyHex)) throw new Error("invalid Taproot wallet public key");
      const internal = Buffer.from(input.publicKeyHex, "hex");
      const derived = bitcoin.payments.p2tr({ internalPubkey: internal, network });
      if (!derived.output?.equals(fundingScript)) throw new Error("Taproot wallet public key does not match funding script");
      tapInternalKey = internal;
    }
    if (!Number.isSafeInteger(input.valueSats) || input.valueSats < 0)
      throw new Error("invalid input value");
    inputSats += BigInt(input.valueSats);
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      witnessUtxo: { script: Buffer.from(input.scriptHex, "hex"), value: input.valueSats },
      sighashType: bitcoin.Transaction.SIGHASH_ALL,
      ...(redeemScript ? { redeemScript } : {}),
      ...(tapInternalKey ? { tapInternalKey } : {}),
    });
  }
  let outputSats = 0n;
  for (const output of txTemplate.outputs) {
    psbt.addOutput({ script: Buffer.from(output.scriptHex, "hex"), value: output.valueSats });
    outputSats += BigInt(output.valueSats);
  }
  if (inputSats !== outputSats + BigInt(minerFeeSats)) {
    throw new Error(
      "inputs must fund outputs and miner fee exactly; add explicit change output to template",
    );
  }
  return psbt;
}

export { selectCrcFunding } from "./funding.js";
export { verifyCrcWalletSignedPsbt, verifyCrcGuardianSignedPsbt } from "./intent.js";
