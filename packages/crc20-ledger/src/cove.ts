import { parseCrc20Transaction, type BitcoinNetwork, type TxOutput } from "@crclaunch/crc20-base";
import { dustThreshold } from "@crclaunch/cove-economics";
import { applyTransaction, type ApplyResult, type LedgerState, type LedgerTransaction } from "./index.js";

export type RegisteredCoveDeployment = Readonly<{
  network: BitcoinNetwork;
  txid: string;
  vaultScriptHex: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  vaultAnchorSats: number;
}>;

function sameOutput(output: TxOutput | undefined, valueSats: number, scriptHex: string): boolean {
  return output?.valueSats === valueSats && output.scriptHex.toLowerCase() === scriptHex.toLowerCase();
}

function invalid(state: LedgerState, reason: string): ApplyResult {
  return { status: "invalid", reason, state };
}

export type CoveOperationResult =
  | { status: "valid"; kind: "mint" | "transfer"; amountAtoms: bigint }
  | { status: "invalid"; reason: string };

export function validateCoveOperation(
  outputs: readonly TxOutput[],
  asset: Readonly<{ txid: string; ticker: string }>,
): CoveOperationResult {
  if (!outputs[0] || outputs[0].scriptHex.length > 520) {
    return { status: "invalid", reason: "Cove marker exceeds 256-byte payload limit" };
  }
  const parsed = parseCrc20Transaction(outputs);
  if (parsed.status !== "valid" || parsed.envelope.kind === "deploy") {
    return { status: "invalid", reason: parsed.status === "invalid" ? parsed.reason : "not a Cove operation" };
  }
  const { envelope } = parsed;
  const payload = envelope.payload;
  if (
    envelope.markerVout !== 0 ||
    Object.keys(payload).sort().join(",") !== "amt,id,op,p,tick" ||
    payload.p !== "crc-20" ||
    payload.op !== envelope.kind ||
    payload.tick !== asset.ticker ||
    payload.id !== asset.txid ||
    !/^[0-9a-f]{64}$/.test(asset.txid) ||
    typeof payload.amt !== "string" ||
    !/^[1-9][0-9]*$/.test(payload.amt)
  ) return { status: "invalid", reason: "invalid Cove operation marker or asset id" };
  const recipient = outputs[1];
  const script = recipient && Buffer.from(recipient.scriptHex, "hex");
  const supported = script && (
    (script.length === 22 && script[0] === 0 && script[1] === 0x14) ||
    (script.length === 34 && script[0] === 0 && script[1] === 0x20) ||
    (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) ||
    (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) ||
    (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87)
  );
  if (!recipient || !Number.isSafeInteger(recipient.valueSats) || recipient.valueSats <= 0 || !supported ||
    BigInt(recipient.valueSats) < dustThreshold(script) ||
    outputs.slice(1).some((output) => output.scriptHex.toLowerCase().startsWith("6a"))) {
    return { status: "invalid", reason: "invalid or ambiguous Cove recipient output" };
  }
  return { status: "valid", kind: envelope.kind, amountAtoms: BigInt(payload.amt) };
}

export function applyRegisteredCoveDeploy(
  state: LedgerState,
  transaction: LedgerTransaction,
  registrations: readonly RegisteredCoveDeployment[],
): ApplyResult {
  const registration = registrations.find(
    (entry) => entry.network === transaction.network && entry.txid === transaction.txid,
  );
  if (!registration) return { status: "ignored", reason: "deployment is not registered by Cove", state };
  if (!transaction.outputs[0] || transaction.outputs[0].scriptHex.length > 520) {
    return invalid(state, "Cove marker exceeds 256-byte payload limit");
  }
  const parsed = parseCrc20Transaction(transaction.outputs);
  if (parsed.status !== "valid" || parsed.envelope.kind !== "deploy") {
    return invalid(state, parsed.status === "invalid" ? parsed.reason : "registered transaction is not a deploy");
  }
  const payload = parsed.envelope.payload;
  if (
    Object.keys(payload).sort().join(",") !== "cv,max,op,p,tick,type" ||
    payload.p !== "crc-20" || payload.op !== "deploy" ||
    payload.type !== "bonding" || payload.cv !== "cove-curve-v1" ||
    payload.max !== "2100000000000000"
  ) return invalid(state, "invalid Cove v1 deploy marker");
  const outputs = transaction.outputs;
  if (outputs.length !== 4 && outputs.length !== 5) return invalid(state, "invalid deploy output count");
  if (
    !Number.isSafeInteger(registration.vaultAnchorSats) || registration.vaultAnchorSats < 0 ||
    BigInt(registration.vaultAnchorSats) < dustThreshold(Buffer.from(registration.vaultScriptHex, "hex")) ||
    registration.vaultScriptHex === registration.creatorScriptHex ||
    registration.vaultScriptHex === registration.protocolScriptHex ||
    !sameOutput(outputs[1], registration.vaultAnchorSats, registration.vaultScriptHex) ||
    !sameOutput(outputs[2], 1_000, registration.creatorScriptHex) ||
    !sameOutput(outputs[3], 7_000, registration.protocolScriptHex)
  ) return invalid(state, "Cove deploy anchor, creator, or protocol output mismatch");
  if (outputs.length === 5 && (!outputs[4] || outputs[4].valueSats < 330 || outputs[4].scriptHex.startsWith("6a"))) {
    return invalid(state, "invalid deploy change output");
  }
  return applyTransaction(state, transaction);
}
