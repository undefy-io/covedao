import { dustThreshold } from "@crclaunch/cove-economics";
import type { FundingInput } from "./index.js";

const MAX_MINER_FEE_SATS = 20_000;

function spendable(scriptHex: string): boolean {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(scriptHex)) return false;
  const script = Buffer.from(scriptHex, "hex");
  return (script.length === 22 && script[0] === 0 && script[1] === 0x14) ||
    (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) ||
    (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87);
}

export function selectCrcFunding(params: {
  mandatoryInputs: readonly FundingInput[];
  candidates: readonly FundingInput[];
  outputsSats: number;
  minerFeeSats: number;
  changeScriptHex: string;
  maxInputs?: number;
}): { inputs: FundingInput[]; changeSats: number; minerFeeSats: number } {
  const { mandatoryInputs, candidates, changeScriptHex } = params;
  const maxInputs = params.maxInputs ?? 40;
  if (!spendable(changeScriptHex)) throw new Error("invalid payment script for change");
  if (!Number.isSafeInteger(params.outputsSats) || params.outputsSats < 0 ||
    !Number.isSafeInteger(params.minerFeeSats) || params.minerFeeSats < 0 ||
    params.minerFeeSats > MAX_MINER_FEE_SATS) throw new Error("invalid miner fee or 20000-sat fee cap exceeded");
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1 || mandatoryInputs.length > maxInputs) {
    throw new Error("CRC funding input count exceeds limit");
  }
  const seen = new Set<string>();
  for (const input of [...mandatoryInputs, ...candidates]) {
    if (!/^[0-9a-fA-F]{64}$/.test(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0 ||
      !Number.isSafeInteger(input.valueSats) || input.valueSats < 0 || !spendable(input.scriptHex)) {
      throw new Error("invalid CRC funding input");
    }
    const outpoint = `${input.txid.toLowerCase()}:${input.vout}`;
    if (seen.has(outpoint)) throw new Error("duplicate CRC funding outpoint");
    seen.add(outpoint);
  }
  if (candidates.some((input) => "tokenAtoms" in input &&
    ((input as FundingInput & { tokenAtoms?: bigint }).tokenAtoms !== 0n ||
      (input as FundingInput & { tokenDeploymentTxid?: string }).tokenDeploymentTxid !== undefined))) {
    throw new Error("token-bearing input cannot be ordinary BTC funding");
  }
  if (candidates.some((input) => input.scriptHex.toLowerCase() !== changeScriptHex.toLowerCase())) {
    throw new Error("candidate UTXO does not belong to the payment script");
  }
  const ordered = [...candidates].sort((a, b) => b.valueSats - a.valueSats ||
    a.txid.localeCompare(b.txid) || a.vout - b.vout);
  const inputs = [...mandatoryInputs];
  let total = mandatoryInputs.reduce((sum, input) => sum + BigInt(input.valueSats), 0n);
  const target = BigInt(params.outputsSats) + BigInt(params.minerFeeSats);
  for (const input of ordered) {
    if (total >= target) break;
    if (inputs.length >= maxInputs) throw new Error("CRC funding input count exceeds limit");
    inputs.push(input);
    total += BigInt(input.valueSats);
  }
  if (total < target) throw new Error("insufficient CRC wallet funding");
  const remainder = total - target;
  const dust = dustThreshold(Buffer.from(changeScriptHex, "hex"));
  if (remainder > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CRC change exceeds safe integer");
  const changeSats = remainder >= dust ? Number(remainder) : 0;
  const minerFeeSats = params.minerFeeSats + (changeSats === 0 ? Number(remainder) : 0);
  if (minerFeeSats > MAX_MINER_FEE_SATS) throw new Error("20000-sat miner fee cap exceeded");
  return { inputs, changeSats, minerFeeSats };
}
