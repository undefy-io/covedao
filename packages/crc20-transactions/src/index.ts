import * as bitcoin from "bitcoinjs-lib";
import { parseCrc20Transaction, type TxOutput } from "@crclaunch/crc20-base";
import { quoteBuy, quoteSell, type CurveState } from "@crclaunch/crc20-curve";
import { dustThreshold } from "@crclaunch/cove-economics";

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
}>;

export type TxTemplate = Readonly<{
  operation: "deploy" | "mint" | "transfer";
  tx: bitcoin.Transaction;
  outputs: readonly TxOutput[];
  markerBytes: number;
  requiredFundingSats: number;
  previousVaultOutpoint?: string;
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

function marker(payload: Record<string, string>): { output: TxOutput; bytes: number } {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  if (data.length > 256) throw new Error("Cove marker exceeds 256-byte payload limit");
  const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, data]);
  return { output: { valueSats: 0, scriptHex: script.toString("hex") }, bytes: data.length };
}

function template(
  operation: TxTemplate["operation"],
  payload: Record<string, string>,
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
  scripts: ScriptSet;
  vaultAnchorSats: number;
}): TxTemplate {
  if (params.maxAtoms !== COVE_V1_MAX_ATOMS) throw new Error("invalid maximum supply for Cove v1");
  return template(
    "deploy",
    {
      p: "crc-20",
      op: "deploy",
      tick: params.ticker,
      type: "bonding",
      max: params.maxAtoms,
      cv: "cove-curve-v1",
    },
    [
      { valueSats: params.vaultAnchorSats, scriptHex: params.scripts.vault },
      { valueSats: COVE_V1_CREATOR_RECORD_SATS, scriptHex: params.scripts.creator },
      { valueSats: COVE_V1_LAUNCH_FEE_SATS, scriptHex: params.scripts.protocol },
    ],
    params.vaultAnchorSats + COVE_V1_CREATOR_RECORD_SATS + COVE_V1_LAUNCH_FEE_SATS,
  );
}

export function buildCurveBuy(params: {
  ticker: string;
  deploymentTxid: string;
  state: CurveState;
  amountTokens: bigint;
  scripts: ScriptSet;
  recipientSats: number;
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
    ],
    safeSats(
      quote.grossSats + quote.protocolFeeSats + quote.creatorFeeSats + BigInt(params.recipientSats),
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
}): TxTemplate {
  if (!/^[0-9a-f]{64}$/.test(params.deploymentTxid)) throw new Error("invalid deployment txid");
  const quote = quoteSell(params.state, params.amountTokens);
  return template(
    "transfer",
    { p: "crc-20", op: "transfer", tick: params.ticker, amt: quote.amountAtoms.toString(), id: params.deploymentTxid },
    [
      {
        valueSats: safeSats(params.state.vaultSats - quote.grossSats),
        scriptHex: params.scripts.vault,
      },
      { valueSats: safeSats(quote.sellerPayoutSats), scriptHex: params.scripts.seller },
      { valueSats: safeSats(quote.protocolFeeSats), scriptHex: params.scripts.protocol },
    ],
    safeSats(quote.walletTopUpSats),
    params.state.vaultOutpoint,
  );
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
    if (!Number.isSafeInteger(input.valueSats) || input.valueSats < 0)
      throw new Error("invalid input value");
    inputSats += BigInt(input.valueSats);
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      witnessUtxo: { script: Buffer.from(input.scriptHex, "hex"), value: input.valueSats },
      sighashType: bitcoin.Transaction.SIGHASH_ALL,
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
