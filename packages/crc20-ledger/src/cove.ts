import { parseCrc20Transaction, type BitcoinNetwork, type TxOutput } from "@crclaunch/crc20-base";
import { dustThreshold } from "@crclaunch/cove-economics";
import { isCoveCurveDeploy } from "@crclaunch/crc20-curve";

export type CoveDeployTransaction = Readonly<{ network: BitcoinNetwork; txid: string; outputs: readonly TxOutput[] }>;
export type CoveDeployResult = Readonly<{ status: "applied" | "invalid" | "ignored"; reason: string }>;

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

function invalid(reason: string): CoveDeployResult {
  return { status: "invalid", reason };
}

function markerPayloadLength(scriptHex: string): number {
  const bytes = Buffer.from(scriptHex, "hex");
  if (bytes[0] !== 0x6a) return Number.POSITIVE_INFINITY;
  const opcode = bytes[1];
  if (opcode === undefined) return Number.POSITIVE_INFINITY;
  const offset = opcode <= 0x4b ? 2 : opcode === 0x4c ? 3 : opcode === 0x4d ? 4 : opcode === 0x4e ? 6 : 0;
  return offset > 0 ? bytes.length - offset : Number.POSITIVE_INFINITY;
}

export type CoveOperationResult =
  | { status: "valid"; kind: "mint" | "transfer"; amountAtoms: bigint; recipientVout: number; inferredAmount?: boolean }
  | { status: "invalid"; reason: string };

export function validateCoveOperation(
  outputs: readonly TxOutput[],
  asset: Readonly<{ txid: string; ticker: string }>,
): CoveOperationResult {
  const parsed = parseCrc20Transaction(outputs);
  const markerVout = parsed.status === "valid" ? parsed.envelope.markerVout : 0;
  if (!outputs[markerVout] || outputs[markerVout].scriptHex.length > 520 ||
    markerPayloadLength(outputs[markerVout].scriptHex) > 256) {
    return { status: "invalid", reason: "Cove marker exceeds 256-byte payload limit" };
  }
  if (parsed.status !== "valid" || parsed.envelope.kind === "deploy") {
    return { status: "invalid", reason: parsed.status === "invalid" ? parsed.reason : "not a Cove operation" };
  }
  const { envelope } = parsed;
  const payload = envelope.payload;
  const keys = Object.keys(payload).sort().join(",");
  const market = envelope.kind === "transfer" && envelope.markerVout === 1;
    if ((market && (outputs[0]?.scriptHex.toLowerCase().startsWith("6a") || !outputs[0]?.valueSats)) ||
      (!market && envelope.markerVout !== 0) ||
      keys !== (envelope.kind === "mint" ? "op,p,tick" : "amt,op,p,tick") ||
      payload.p !== "crc-20" || payload.op !== envelope.kind || payload.tick !== asset.ticker ||
      !/^[0-9a-f]{64}$/.test(asset.txid)) {
      return { status: "invalid", reason: "invalid Cove v3 operation marker or ticker" };
    }
    const recipientVout = market ? 2 : 1;
    const recipient = outputs[recipientVout];
    const recipientScript = recipient && Buffer.from(recipient.scriptHex, "hex");
    const supported = recipientScript && (
      (recipientScript.length === 22 && recipientScript[0] === 0 && recipientScript[1] === 0x14) ||
      (recipientScript.length === 34 && recipientScript[0] === 0 && recipientScript[1] === 0x20) ||
      (recipientScript.length === 34 && recipientScript[0] === 0x51 && recipientScript[1] === 0x20) ||
      (recipientScript.length === 25 && recipientScript[0] === 0x76 && recipientScript[1] === 0xa9 &&
        recipientScript[2] === 0x14 && recipientScript[23] === 0x88 && recipientScript[24] === 0xac) ||
      (recipientScript.length === 23 && recipientScript[0] === 0xa9 && recipientScript[1] === 0x14 && recipientScript[22] === 0x87)
    );
    if (!recipient || !recipientScript || !supported || !recipient.valueSats ||
      BigInt(recipient.valueSats) < dustThreshold(recipientScript) ||
      outputs.some((output, index) => index !== envelope.markerVout && output.scriptHex.toLowerCase().startsWith("6a"))) {
      return { status: "invalid", reason: "invalid or ambiguous Cove recipient output" };
    }
    return { status: "valid", kind: envelope.kind, recipientVout,
      amountAtoms: envelope.kind === "mint" ? 0n : BigInt(payload.amt as string),
      ...(envelope.kind === "mint" ? { inferredAmount: true } : {}) };
}

export function applyRegisteredCoveDeploy(
  transaction: CoveDeployTransaction,
  registrations: readonly RegisteredCoveDeployment[],
): CoveDeployResult {
  const registration = registrations.find(
    (entry) => entry.network === transaction.network && entry.txid === transaction.txid,
  );
  if (!registration) return { status: "ignored", reason: "deployment is not registered by Cove" };
  if (registrations.some((entry) => entry.network === transaction.network &&
    entry.txid !== transaction.txid &&
    entry.vaultScriptHex.toLowerCase() === registration.vaultScriptHex.toLowerCase())) {
    return invalid("Cove vault script must be unique per asset");
  }
  if (!transaction.outputs[0] || transaction.outputs[0].scriptHex.length > 520 ||
    markerPayloadLength(transaction.outputs[0].scriptHex) > 256) {
    return invalid("Cove marker exceeds 256-byte payload limit");
  }
  const parsed = parseCrc20Transaction(transaction.outputs);
  if (parsed.status !== "valid" || parsed.envelope.kind !== "deploy") {
    return invalid(parsed.status === "invalid" ? parsed.reason : "registered transaction is not a deploy");
  }
  const payload = parsed.envelope.payload;
  if (!isCoveCurveDeploy(payload)) return invalid("invalid Cove deploy marker");
  const outputs = transaction.outputs;
  if (outputs.length !== 4 && outputs.length !== 5) return invalid("invalid deploy output count");
  if (
    !Number.isSafeInteger(registration.vaultAnchorSats) || registration.vaultAnchorSats < 0 ||
    BigInt(registration.vaultAnchorSats) < dustThreshold(Buffer.from(registration.vaultScriptHex, "hex")) ||
    registration.vaultScriptHex === registration.creatorScriptHex ||
    registration.vaultScriptHex === registration.protocolScriptHex ||
    !sameOutput(outputs[1], registration.vaultAnchorSats, registration.vaultScriptHex) ||
    !sameOutput(outputs[2], 1_000, registration.creatorScriptHex) ||
    !sameOutput(outputs[3], 7_000, registration.protocolScriptHex)
  ) return invalid("Cove deploy anchor, creator, or protocol output mismatch");
  if (outputs.length === 5 && (!outputs[4] || outputs[4].valueSats < 330 || outputs[4].scriptHex.startsWith("6a"))) {
    return invalid("invalid deploy change output");
  }
  return { status: "applied", reason: "registered Cove deployment" };
}
