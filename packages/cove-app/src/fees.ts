import { estimateVsize, SCRIPT_BYTES_P2TR, type SpendKind } from "@crclaunch/bitcoin";

/**
 * Cove-specific transaction shapes.
 *
 * The generic vbyte arithmetic lives in @crclaunch/bitcoin; what belongs here
 * is the knowledge of which outputs each Cove operation produces.
 */

/**
 * OP_RETURN scriptPubKey length per operation: OP_RETURN + push-length + the
 * wire-v2 envelope, at its largest legal encoding for that operation.
 * Measured from the encoders themselves, not assumed.
 */
export const OP_RETURN_SCRIPT_BYTES = {
  DEPLOY: 50, // 48-byte envelope, 16-character ticker
  BACKING_BUY: 47, // 45-byte envelope, fixed shape
  REDEEM: 56, // 54-byte envelope, one change allocation
  TRANSFER: 75, // 73-byte envelope, four allocations
} as const;

/** Advisory crc-20 discovery envelope, when it is switched on. */
export const DISCOVERY_SCRIPT_BYTES = 75;

export type CoveOperation = "DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER";

export interface OperationShapeInput {
  /** Ordinary BTC funding inputs the user contributes. */
  fundingInputs: number;
  /**
   * What kind of address those funding inputs are.
   *
   * A nested-segwit input is 91 vbytes against a native one's 68, so
   * assuming native for a Xverse or Magic Eden wallet under-prices the
   * transaction by a third — which is the difference between confirming and
   * sitting in the mempool.
   */
  fundingKind?: SpendKind;
  /** Token-carrier inputs (REDEEM, TRANSFER). */
  tokenInputs?: number;
  /** What kind of address the token carriers are; ordinals are Taproot. */
  tokenKind?: SpendKind;
  /** The payments scriptPubKey length (BTC payout and change use it). */
  walletScriptBytes: number;
  /** The ordinals scriptPubKey length (token carriers use it). */
  ordinalsScriptBytes?: number;
  /** The protocol fee destination's scriptPubKey length. */
  feeScriptBytes: number;
  /** Token-carrier outputs going to someone else (TRANSFER). */
  recipientCarriers?: number;
  /** Emit the advisory discovery envelope (BACKING_BUY only). */
  discovery?: boolean;
}

/** Fold a count of inputs of one kind into the generic shape's tallies. */
function tally(
  into: { p2wpkhInputs: number; p2trInputs: number; p2shP2wpkhInputs: number },
  count: number,
  kind: SpendKind = "p2wpkh",
): void {
  if (count <= 0) return;
  if (kind === "p2tr") into.p2trInputs += count;
  else if (kind === "p2sh-p2wpkh") into.p2shP2wpkhInputs += count;
  else into.p2wpkhInputs += count;
}

/**
 * The vbyte size of the transaction a given build will produce. Always assumes
 * a BTC change output: leaving it out would under-estimate the fee, and paying
 * for 31 vbytes that do not appear is the safe direction to be wrong in.
 */
export function estimateOperationVsize(op: CoveOperation, input: OperationShapeInput): number {
  const wallet = input.walletScriptBytes;
  const carrier = input.ordinalsScriptBytes ?? wallet;
  const outputs: number[] = [OP_RETURN_SCRIPT_BYTES[op]];

  switch (op) {
    case "DEPLOY":
      // vault, creator record, launch fee, BTC change
      outputs.push(SCRIPT_BYTES_P2TR, wallet, input.feeScriptBytes, wallet);
      break;
    case "BACKING_BUY":
      // vault successor, token carrier, protocol fee, creator share, BTC change
      outputs.push(SCRIPT_BYTES_P2TR, carrier, input.feeScriptBytes, SCRIPT_BYTES_P2TR, wallet);
      if (input.discovery) outputs.push(DISCOVERY_SCRIPT_BYTES);
      break;
    case "REDEEM":
      // vault successor, payout, protocol fee, token change carrier, BTC change
      outputs.push(SCRIPT_BYTES_P2TR, wallet, input.feeScriptBytes, carrier, wallet);
      break;
    case "TRANSFER":
      // recipient carriers, own change carrier, BTC change
      for (let i = 0; i < (input.recipientCarriers ?? 1); i++) outputs.push(carrier);
      outputs.push(carrier, wallet);
      break;
  }

  const inputs = { p2wpkhInputs: 0, p2trInputs: 0, p2shP2wpkhInputs: 0 };
  tally(inputs, input.fundingInputs, input.fundingKind);
  tally(inputs, input.tokenInputs ?? 0, input.tokenKind);

  return estimateVsize({
    vaultInputs: op === "BACKING_BUY" || op === "REDEEM" ? 1 : 0,
    ...inputs,
    outputScriptBytes: outputs,
  });
}

export {
  estimateVsize,
  loadFeeRates,
  resolveMinerFee,
  outputVbytes,
  FeeError,
  SCRIPT_BYTES_P2TR,
  VB_TX_OVERHEAD,
  VB_INPUT_P2WPKH,
  VB_INPUT_P2TR_KEYPATH,
  VB_INPUT_VAULT,
  ABSOLUTE_FLOOR_SAT_PER_VB,
  ABSOLUTE_CEILING_SAT_PER_VB,
  type CoveTxShape,
  type FeeRates,
  type FeeTier,
  type FeeTierKey,
} from "@crclaunch/bitcoin";
